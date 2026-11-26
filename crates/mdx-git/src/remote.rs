//! Fetch, pull and push.
//!
//! * Nothing is ever force-pushed: refspecs are explicit and carry no `+`.
//! * Pull only fast-forwards, so it never creates a merge or rewrites local commits.
//! * There is no terminal, so anything that would prompt fails with git's message instead,
//!   and a stalled connection is cut off after [`NETWORK_TIMEOUT`].

use std::io::Read;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::{run, GitError, Mode, Repo, Result};

pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    /// Where it went, e.g. `origin/main`.
    pub target: String,
    /// The branch did not exist on the remote before (it now tracks it).
    pub published: bool,
    /// Commits uploaded to an existing branch.
    pub commits: u32,
}

impl Repo {
    /// Update every remote's branches, forgetting ones deleted there.
    pub fn fetch(&self) -> Result<()> {
        if self.status()?.remotes.is_empty() {
            return Err(no_remote());
        }
        self.network(&["fetch", "--all", "--prune"])
    }

    /// Fetch the current branch's upstream and fast-forward to it. Returns the number of new
    /// commits. Fails, changing nothing, if both sides have commits of their own.
    pub fn pull(&self) -> Result<u32> {
        let branch = self.current_branch()?;
        let (remote, _) =
            self.upstream(&branch)?.ok_or_else(|| GitError::Invalid(format!("\"{branch}\" has no upstream branch to pull from")))?;
        // A branch may track another local branch (remote "."): nothing to fetch then.
        if remote != "." {
            self.network(&["fetch", "--prune", &remote])?;
        }
        let status = self.status()?;
        if status.upstream_gone {
            return Err(GitError::Invalid("the upstream branch no longer exists on the remote".into()));
        }
        if status.ahead > 0 && status.behind > 0 {
            return Err(GitError::Invalid(format!(
                "cannot pull: you have {} local and the remote has {} new commits. Merge or rebase in a terminal.",
                status.ahead, status.behind
            )));
        }
        if status.behind > 0 {
            self.write(&["merge", "--ff-only", "@{upstream}"], None)?;
        }
        Ok(status.behind)
    }

    /// Push the current branch to its upstream, or publish it if it has none.
    pub fn push(&self) -> Result<Pushed> {
        let branch = self.current_branch()?;
        let status = self.status()?;
        if status.head.is_none() {
            return Err(GitError::Invalid("there is nothing to push: make a commit first".into()));
        }
        let local = format!("refs/heads/{branch}");
        match self.upstream(&branch)? {
            Some((remote, merge)) => {
                // Like git's default (`push.default = simple`): never push into a branch of
                // another name just because this one was started from it.
                if merge != local || remote == "." {
                    return Err(GitError::Invalid(format!(
                        "\"{branch}\" tracks \"{}\", which has a different name or is local. Push it from a terminal.",
                        status.upstream.unwrap_or(merge)
                    )));
                }
                self.network(&["push", &remote, &format!("{local}:{merge}")])?;
                Ok(Pushed { target: format!("{remote}/{branch}"), published: status.upstream_gone, commits: status.ahead })
            }
            None => {
                let remote = self.publish_remote(&branch, &status.remotes)?;
                self.network(&["push", "--set-upstream", &remote, &format!("{local}:{local}")])?;
                Ok(Pushed { target: format!("{remote}/{branch}"), published: true, commits: 0 })
            }
        }
    }

    fn current_branch(&self) -> Result<String> {
        self.status()?.branch.ok_or_else(|| GitError::Invalid("switch to a branch first (HEAD is detached)".into()))
    }

    /// `(remote, ref on that remote)` configured for a branch.
    fn upstream(&self, branch: &str) -> Result<Option<(String, String)>> {
        Ok(self.config(&format!("branch.{branch}.remote"))?.zip(self.config(&format!("branch.{branch}.merge"))?))
    }

    fn publish_remote(&self, branch: &str, remotes: &[String]) -> Result<String> {
        let configured = match self.config(&format!("branch.{branch}.pushRemote"))? {
            Some(r) => Some(r),
            None => self.config("remote.pushDefault")?,
        };
        configured
            .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
            .or_else(|| (remotes.len() == 1).then(|| remotes[0].clone()))
            .ok_or_else(|| {
                if remotes.is_empty() {
                    no_remote()
                } else {
                    GitError::Invalid("several remotes and none is called origin: set remote.pushDefault".into())
                }
            })
    }

    fn config(&self, key: &str) -> Result<Option<String>> {
        // Exits unsuccessfully when the key is not set.
        let out = run(&self.top, Mode::Read, &["config", "--get", key], None)?;
        Ok(out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim_end().to_owned()).filter(|v| !v.is_empty()))
    }

    fn network(&self, args: &[&str]) -> Result<()> {
        crate::checked(run(&self.top, Mode::Network, args, None)?).map(|_| ())
    }
}

fn no_remote() -> GitError {
    GitError::Invalid("no remote is configured. Add one with: git remote add origin <url>".into())
}

/// Run a prepared network command with the safeguards described above.
pub(crate) fn wait(mut command: Command, dir: &Path) -> Result<Output> {
    // Make ssh fail rather than ask for a passphrase, unless the user chose their own command.
    let custom_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || run(dir, Mode::Read, &["config", "--get", "core.sshCommand"], None)?.status.success();
    if !custom_ssh {
        command.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    wait_with_timeout(command, NETWORK_TIMEOUT)
}

fn wait_with_timeout(mut command: Command, timeout: Duration) -> Result<Output> {
    let mut child = command.spawn().map_err(GitError::Spawn)?;
    // Drain both pipes on threads; a child of git (ssh) may keep them open after a kill,
    // so the results are collected through channels that can be abandoned.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            let _ = send.send(bytes);
        });
        receive
    };
    let stdout = drain(child.stdout.take().map(|p| Box::new(p) as _));
    let stderr = drain(child.stderr.take().map(|p| Box::new(p) as _));
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(GitError::Spawn)? {
            let collect = |r: mpsc::Receiver<Vec<u8>>| r.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
            return Ok(Output { status, stdout: collect(stdout), stderr: collect(stderr) });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitError::Failed(format!("the remote did not answer within {} seconds", timeout.as_secs())));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[cfg(unix)]
    #[test]
    fn a_stalled_command_is_cut_off() {
        let mut command = Command::new("sleep");
        command.arg("30").stdout(Stdio::piped()).stderr(Stdio::piped());
        let started = Instant::now();
        let error = wait_with_timeout(command, Duration::from_millis(200)).unwrap_err();
        assert!(error.to_string().contains("did not answer"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
