//! Git integration, driving the `git` command line so that the user's configuration, hooks,
//! signing and ignore rules behave exactly as they do in a terminal.
//!
//! Safety: opening a folder runs read commands automatically, and a repository's own config
//! can name programs for git to execute. Reads therefore disable the fsmonitor, hooks,
//! external diff drivers and text converters, and never write the index. Commands the user
//! asks for (commit, switch) run hooks as usual.
//!
//! All paths in this API are relative to the repository root and use `/`.

mod blame;
mod discard;
mod remote;
mod status;

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde::Serialize;

pub use blame::{Blame, BlameCommit};
pub use remote::{Pushed, NETWORK_TIMEOUT};
pub use status::{ChangedFile, Status};

/// Larger files are reported as binary rather than loaded into the diff view.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("could not run git: {0}. Is Git installed?")]
    Spawn(std::io::Error),
    /// git exited unsuccessfully; this is what it said.
    #[error("{0}")]
    Failed(String),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, GitError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// `main`, or `origin/main` for a remote branch.
    pub name: String,
    pub remote: bool,
    pub current: bool,
}

/// Two versions of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old: String,
    pub new: String,
    /// Binary or too large to show; `old` and `new` are empty.
    pub binary: bool,
}

#[derive(Debug, Clone)]
pub struct Repo {
    top: PathBuf,
}

#[derive(Clone, Copy)]
enum Mode {
    /// Runs automatically: must not execute anything the repository configures, or write.
    Read,
    /// Explicitly requested by the user.
    Write,
    /// A user request that talks to a remote: it must not wait for input or hang for ever.
    Network,
}

impl Repo {
    /// The repository containing `dir`, or `None` if it is not inside a work tree.
    pub fn discover(dir: &Path) -> Result<Option<Repo>> {
        let out = run(dir, Mode::Read, &["rev-parse", "--show-toplevel"], None)?;
        if !out.status.success() {
            let message = String::from_utf8_lossy(&out.stderr);
            // Also covers bare repositories and the inside of `.git`.
            if message.contains("not a git repository") || message.contains("must be run in a work tree") {
                return Ok(None);
            }
            return Err(GitError::Failed(message.trim().to_owned()));
        }
        let top = String::from_utf8_lossy(&out.stdout).trim_end_matches(['\n', '\r']).to_owned();
        Ok(Some(Repo { top: PathBuf::from(top) }))
    }

    /// Absolute path of the work tree.
    pub fn root(&self) -> &Path {
        &self.top
    }

    pub fn status(&self) -> Result<Status> {
        let out = self.read(&["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
        let mut status = status::parse(&out);
        status.remotes = String::from_utf8_lossy(&self.read(&["remote"])?).lines().map(str::to_owned).collect();
        Ok(status)
    }

    pub fn stage(&self, paths: &[String]) -> Result<()> {
        self.with_paths(&["add", "-A"], paths)
    }

    pub fn unstage(&self, paths: &[String]) -> Result<()> {
        // `reset` also works before the first commit, unlike `restore --staged`.
        self.with_paths(&["reset", "-q"], paths)
    }

    /// Commit what is staged. Returns the new commit's short id.
    pub fn commit(&self, message: &str) -> Result<String> {
        if message.trim().is_empty() {
            return Err(GitError::Invalid("enter a commit message".into()));
        }
        self.write(&["commit", "-F", "-"], Some(message.as_bytes()))?;
        Ok(String::from_utf8_lossy(&self.read(&["rev-parse", "--short", "HEAD"])?).trim().to_owned())
    }

    /// Local branches first, then remote ones.
    pub fn branches(&self) -> Result<Vec<Branch>> {
        let out = self.read(&["for-each-ref", "--format=%(refname)%00%(HEAD)", "refs/heads", "refs/remotes"])?;
        let mut branches: Vec<Branch> = String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|line| {
                let (reference, head) = line.split_once('\0')?;
                let (name, remote) = match reference.strip_prefix("refs/heads/") {
                    Some(name) => (name, false),
                    None => (reference.strip_prefix("refs/remotes/")?, true),
                };
                // `origin/HEAD` only points at another remote branch.
                (!(remote && name.ends_with("/HEAD"))).then(|| Branch { name: name.to_owned(), remote, current: head == "*" })
            })
            .collect();
        // A repository without commits has a branch that no ref names yet.
        if !branches.iter().any(|b| b.current) {
            if let Some(name) = self.status()?.branch.filter(|_| branches.is_empty()) {
                branches.push(Branch { name, remote: false, current: true });
            }
        }
        Ok(branches)
    }

    /// Switch to an existing local branch, or create a tracking branch for a remote one.
    /// git refuses if uncommitted changes would be overwritten.
    pub fn switch(&self, name: &str) -> Result<()> {
        let branches = self.branches()?;
        let branch = branches.iter().find(|b| b.name == name).ok_or_else(|| GitError::Invalid(format!("no branch named \"{name}\"")))?;
        if !branch.remote {
            return self.write(&["switch", name], None);
        }
        // `origin/topic`: use the local `topic` if there is one.
        let local = name.split_once('/').map_or(name, |(_, rest)| rest);
        if branches.iter().any(|b| !b.remote && b.name == local) {
            self.write(&["switch", local], None)
        } else {
            self.write(&["switch", "--track", name], None)
        }
    }

    /// Create a branch at the current commit and switch to it. Uncommitted changes come along.
    pub fn create_branch(&self, name: &str) -> Result<()> {
        let valid = !name.starts_with('-') && run(&self.top, Mode::Read, &["check-ref-format", "--branch", name], None)?.status.success();
        // `@{-1}` and friends pass the format check but are not names.
        if !valid || name.contains("@{") {
            return Err(GitError::Invalid(format!("\"{name}\" is not a valid branch name")));
        }
        self.write(&["switch", "-c", name], None)
    }

    /// `staged`: last commit → index. Otherwise: index → working tree (an untracked file is
    /// all new; a conflicted one is compared with the last commit).
    pub fn diff(&self, path: &str, staged: bool) -> Result<FileDiff> {
        check_path(path)?;
        let status = self.status()?;
        let entry = status.files.iter().find(|f| f.path == path);
        let (old, new) = if staged {
            let before = entry.and_then(|e| e.orig_path.as_deref()).unwrap_or(path);
            (self.blob(&format!("HEAD:{before}"))?, self.blob(&format!(":{path}"))?)
        } else {
            let base = if entry.is_some_and(|e| e.conflicted) { format!("HEAD:{path}") } else { format!(":{path}") };
            (self.blob(&base)?, self.work_file(path)?)
        };
        let binary = [&old, &new].iter().any(|v| v.len() > MAX_DIFF_BYTES || v.contains(&0));
        let text = |v: Vec<u8>| if binary { String::new() } else { String::from_utf8_lossy(&v).into_owned() };
        Ok(FileDiff { old: text(old), new: text(new), binary })
    }

    /// Who last changed each line of `contents` (the editor's text, saved or not).
    pub fn blame(&self, path: &str, contents: &str) -> Result<Blame> {
        check_path(path)?;
        // A file git has no history for is entirely uncommitted.
        if !run(&self.top, Mode::Read, &["cat-file", "-e", &format!("HEAD:{path}")], None)?.status.success() {
            return Ok(Blame::uncommitted(contents.lines().count()));
        }
        let args = ["blame", "--porcelain", "--no-textconv", "--contents", "-", "--", path];
        let out = checked(run(&self.top, Mode::Read, &args, Some(contents.as_bytes()))?)?;
        Ok(blame::parse(&String::from_utf8_lossy(&out)))
    }

    /// A file as stored in git, empty if it does not exist there.
    fn blob(&self, spec: &str) -> Result<Vec<u8>> {
        if !run(&self.top, Mode::Read, &["cat-file", "-e", spec], None)?.status.success() {
            return Ok(Vec::new());
        }
        self.read(&["cat-file", "blob", spec])
    }

    fn work_file(&self, path: &str) -> Result<Vec<u8>> {
        let full = self.top.join(path);
        match full.symlink_metadata() {
            // git stores the link's target, and following it could leave the repository.
            Ok(m) if m.is_symlink() => {
                Ok(std::fs::read_link(&full).map(|t| t.to_string_lossy().into_owned().into_bytes()).unwrap_or_default())
            }
            Ok(m) if m.is_file() => {
                let parent = full.parent().and_then(|p| p.canonicalize().ok());
                if !parent.is_some_and(|p| self.top.canonicalize().is_ok_and(|top| p.starts_with(top))) {
                    return Err(GitError::Invalid(format!("{path} is outside the repository")));
                }
                std::fs::read(full).map_err(|e| GitError::Failed(format!("could not read {path}: {e}")))
            }
            // Deleted.
            _ => Ok(Vec::new()),
        }
    }

    fn with_paths(&self, command: &[&str], paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        for path in paths {
            check_path(path)?;
        }
        let mut args = command.to_vec();
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        self.write(&args, None)
    }

    fn read(&self, args: &[&str]) -> Result<Vec<u8>> {
        checked(run(&self.top, Mode::Read, args, None)?)
    }

    fn write(&self, args: &[&str], input: Option<&[u8]>) -> Result<()> {
        checked(run(&self.top, Mode::Write, args, input)?).map(|_| ())
    }
}

/// Repository-relative paths only: no absolute paths, no `..`, nothing inside `.git`.
fn check_path(path: &str) -> Result<()> {
    let ok = !path.is_empty()
        && Path::new(path).components().all(|c| matches!(c, Component::Normal(name) if !name.eq_ignore_ascii_case(".git")));
    ok.then_some(()).ok_or_else(|| GitError::Invalid(format!("invalid path: {path}")))
}

fn run(dir: &Path, mode: Mode, args: &[&str], input: Option<&[u8]>) -> Result<Output> {
    let mut command = Command::new("git");
    command.current_dir(dir);
    if matches!(mode, Mode::Read) {
        command.args(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]).env("GIT_OPTIONAL_LOCKS", "0");
    }
    command
        .args(["-c", "core.quotePath=false"])
        .args(args)
        // Inherited variables could point git at a different repository.
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        // File names are names, never glob patterns.
        .env("GIT_LITERAL_PATHSPECS", "1")
        // There is no terminal to prompt on.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_MESSAGES", "C")
        .env_remove("LC_ALL")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if matches!(mode, Mode::Network) {
        return remote::wait(command, dir);
    }
    let mut child = command.spawn().map_err(GitError::Spawn)?;
    // Write from a thread so large input cannot deadlock against the output pipes.
    let writer = input.and_then(|bytes| {
        let mut stdin = child.stdin.take()?;
        let bytes = bytes.to_vec();
        Some(std::thread::spawn(move || stdin.write_all(&bytes)))
    });
    let out = child.wait_with_output().map_err(GitError::Spawn)?;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    Ok(out)
}

fn checked(out: Output) -> Result<Vec<u8>> {
    if out.status.success() {
        return Ok(out.stdout);
    }
    // Hooks and `commit` ("nothing to commit") often explain themselves on stdout.
    let text = [&out.stderr, &out.stdout].map(|b| String::from_utf8_lossy(b).trim().to_owned());
    let message = text.into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
    Err(GitError::Failed(if message.is_empty() { format!("git failed ({})", out.status) } else { message }))
}

#[cfg(test)]
mod tests;
