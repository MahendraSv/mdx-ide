//! End-to-end tests against real temporary repositories.

use std::fs;
use std::process::Command;

use super::*;

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(dir).args(args).env_remove("GIT_DIR").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// An empty repository, isolated from the developer's identity, signing and hooks.
fn empty() -> (tempfile::TempDir, Repo) {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path();
    git(d, &["init", "-q"]);
    git(d, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    for (key, value) in [
        ("user.name", "Ada"),
        ("user.email", "ada@example.com"),
        ("commit.gpgsign", "false"),
        ("core.autocrlf", "false"),
        ("core.hooksPath", ".git/hooks"),
    ] {
        git(d, &["config", key, value]);
    }
    let repo = Repo::discover(d).unwrap().unwrap();
    (dir, repo)
}

fn write(dir: &Path, path: &str, text: &str) {
    let full = dir.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, text).unwrap();
}

fn paths(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn summary(repo: &Repo) -> Vec<(String, Option<char>, Option<char>)> {
    repo.status().unwrap().files.into_iter().map(|f| (f.path, f.staged, f.unstaged)).collect()
}

#[test]
fn discovers_from_subfolders_only_inside_a_repository() {
    let outside = tempfile::tempdir().unwrap();
    assert!(Repo::discover(outside.path()).unwrap().is_none());
    let (d, repo) = empty();
    fs::create_dir_all(d.path().join("docs/a")).unwrap();
    let found = Repo::discover(&d.path().join("docs/a")).unwrap().unwrap();
    assert_eq!(found.root(), repo.root());
    assert!(Repo::discover(&d.path().join(".git")).unwrap().is_none());
}

#[test]
fn stages_unstages_and_commits_including_the_first_commit() {
    let (d, repo) = empty();
    write(d.path(), "a.mdx", "# A\n");
    write(d.path(), "docs/[b] *.mdx", "# B\n");
    let status = repo.status().unwrap();
    assert_eq!((status.branch.as_deref(), status.head), (Some("main"), None));
    assert_eq!(repo.branches().unwrap(), vec![Branch { name: "main".into(), remote: false, current: true }]);

    // Glob characters in a name are literal.
    repo.stage(&paths(&["docs/[b] *.mdx"])).unwrap();
    assert_eq!(summary(&repo), vec![("a.mdx".into(), None, Some('U')), ("docs/[b] *.mdx".into(), Some('A'), None)]);
    // Unstaging works before any commit exists.
    repo.unstage(&paths(&["docs/[b] *.mdx"])).unwrap();
    assert_eq!(summary(&repo)[1].2, Some('U'));

    assert!(repo.commit("   ").is_err());
    assert!(repo.commit("nothing staged").unwrap_err().to_string().contains("nothing"));
    repo.stage(&paths(&["a.mdx", "docs/[b] *.mdx"])).unwrap();
    let id = repo.commit("First\n\nBody with 'quotes' and -- dashes\n").unwrap();
    assert_eq!(repo.status().unwrap().head, Some(id));
    assert!(summary(&repo).is_empty());
}

#[test]
fn reports_and_stages_deletions_and_renames() {
    let (d, repo) = empty();
    write(d.path(), "a.mdx", "one\ntwo\nthree\n");
    write(d.path(), "b.mdx", "bee\n");
    repo.stage(&paths(&["a.mdx", "b.mdx"])).unwrap();
    repo.commit("init").unwrap();

    fs::rename(d.path().join("a.mdx"), d.path().join("c.mdx")).unwrap();
    fs::remove_file(d.path().join("b.mdx")).unwrap();
    repo.stage(&paths(&["a.mdx", "b.mdx", "c.mdx"])).unwrap();
    let files = repo.status().unwrap().files;
    assert_eq!(files.iter().map(|f| (f.path.as_str(), f.staged)).collect::<Vec<_>>(), vec![("b.mdx", Some('D')), ("c.mdx", Some('R'))]);
    assert_eq!(files[1].orig_path.as_deref(), Some("a.mdx"));
    let diff = repo.diff("c.mdx", true).unwrap();
    assert_eq!((diff.old.as_str(), diff.new.as_str()), ("one\ntwo\nthree\n", "one\ntwo\nthree\n"));
    repo.unstage(&paths(&["a.mdx", "c.mdx", "b.mdx"])).unwrap();
    assert_eq!(summary(&repo).len(), 3);
}

#[test]
fn diffs_compare_the_right_versions() {
    let (d, repo) = empty();
    write(d.path(), "a.mdx", "committed\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("init").unwrap();
    write(d.path(), "a.mdx", "staged\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    write(d.path(), "a.mdx", "working\n");
    write(d.path(), "new.mdx", "fresh\n");
    fs::write(d.path().join("img.bin"), [1u8, 0, 2]).unwrap();

    let view = |p: &str, staged| {
        let d = repo.diff(p, staged).unwrap();
        (d.old, d.new, d.binary)
    };
    assert_eq!(view("a.mdx", true), ("committed\n".into(), "staged\n".into(), false));
    assert_eq!(view("a.mdx", false), ("staged\n".into(), "working\n".into(), false));
    assert_eq!(view("new.mdx", false), (String::new(), "fresh\n".into(), false));
    assert!(view("img.bin", false).2);
    fs::remove_file(d.path().join("a.mdx")).unwrap();
    assert_eq!(view("a.mdx", false), ("staged\n".into(), String::new(), false));
    for bad in ["../x", "/etc/passwd", ".git/config", ""] {
        assert!(repo.diff(bad, false).is_err(), "{bad}");
        assert!(repo.stage(&paths(&[bad])).is_err(), "{bad}");
        assert!(repo.blame(bad, "").is_err(), "{bad}");
    }
}

#[cfg(unix)]
#[test]
fn diff_does_not_follow_symlinks_out_of_the_repository() {
    let (d, repo) = empty();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "secret.txt", "top secret\n");
    std::os::unix::fs::symlink(outside.path().join("secret.txt"), d.path().join("link.mdx")).unwrap();
    assert!(!repo.diff("link.mdx", false).unwrap().new.contains("top secret"));
    std::os::unix::fs::symlink(outside.path(), d.path().join("dir")).unwrap();
    assert!(repo.diff("dir/secret.txt", false).is_err());
}

#[test]
fn creates_and_switches_branches_without_losing_changes() {
    let (d, repo) = empty();
    write(d.path(), "a.mdx", "main\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("init").unwrap();

    for bad in ["", "-x", "a b", "a..b", "@{-1}", "x.lock"] {
        assert!(repo.create_branch(bad).is_err(), "{bad:?}");
    }
    repo.create_branch("feature/docs").unwrap();
    write(d.path(), "a.mdx", "feature\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("feature").unwrap();
    repo.switch("main").unwrap();
    assert_eq!(fs::read_to_string(d.path().join("a.mdx")).unwrap(), "main\n");
    let names: Vec<_> = repo.branches().unwrap().into_iter().map(|b| (b.name, b.current)).collect();
    assert_eq!(names, vec![("feature/docs".into(), false), ("main".into(), true)]);

    // A switch that would overwrite uncommitted work is refused.
    write(d.path(), "a.mdx", "unsaved work\n");
    assert!(repo.switch("feature/docs").unwrap_err().to_string().contains("a.mdx"));
    assert_eq!(fs::read_to_string(d.path().join("a.mdx")).unwrap(), "unsaved work\n");
    assert!(repo.switch("nope").is_err() && repo.switch("--detach").is_err());
}

#[test]
fn switches_to_remote_branches_and_counts_ahead() {
    let (origin_dir, origin) = empty();
    write(origin_dir.path(), "a.mdx", "a\n");
    origin.stage(&paths(&["a.mdx"])).unwrap();
    origin.commit("init").unwrap();
    origin.create_branch("topic").unwrap();
    origin.switch("main").unwrap();

    let (d, repo) = empty();
    git(d.path(), &["remote", "add", "origin", origin_dir.path().to_str().unwrap()]);
    git(d.path(), &["fetch", "-q", "origin"]);
    repo.switch("origin/topic").unwrap();
    let status = repo.status().unwrap();
    assert_eq!((status.branch.as_deref(), status.upstream.as_deref()), (Some("topic"), Some("origin/topic")));
    write(d.path(), "b.mdx", "b\n");
    repo.stage(&paths(&["b.mdx"])).unwrap();
    repo.commit("more").unwrap();
    assert_eq!(repo.status().unwrap().ahead, 1);
    // Selecting the remote again uses the existing local branch.
    repo.switch("origin/topic").unwrap();
}

#[test]
fn blames_committed_edited_and_new_lines() {
    let (d, repo) = empty();
    write(d.path(), "a.mdx", "one\ntwo\n");
    assert_eq!(repo.blame("a.mdx", "one\ntwo\n").unwrap(), Blame::uncommitted(2));
    repo.stage(&paths(&["a.mdx"])).unwrap();
    let id = repo.commit("Add page").unwrap();
    // Unsaved editor text: line two edited, line three added.
    let blame = repo.blame("a.mdx", "one\nTWO\nthree\n").unwrap();
    let of = |line: usize| &blame.commits[blame.lines[line]];
    assert_eq!((of(0).id.as_deref(), of(0).author.as_str(), of(0).summary.as_str()), (Some(id.as_str()), "Ada", "Add page"));
    assert!(of(0).time > 0);
    assert_eq!((of(1).id.clone(), of(2).id.clone(), of(1).author.as_str()), (None, None, "You"));
    assert_eq!(blame.lines.len(), 3);
}

#[test]
fn reports_conflicts() {
    let (d, repo) = empty();
    write(d.path(), "a.mdx", "base\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("base").unwrap();
    repo.create_branch("other").unwrap();
    write(d.path(), "a.mdx", "theirs\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("theirs").unwrap();
    repo.switch("main").unwrap();
    write(d.path(), "a.mdx", "ours\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("ours").unwrap();
    assert!(!Command::new("git").current_dir(d.path()).args(["merge", "other"]).output().unwrap().status.success());

    assert!(repo.status().unwrap().files[0].conflicted);
    let diff = repo.diff("a.mdx", false).unwrap();
    assert!(diff.old == "ours\n" && diff.new.contains("<<<<<<<"));
    write(d.path(), "a.mdx", "resolved\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("merge").unwrap();
}

#[cfg(unix)]
#[test]
fn reading_never_runs_repository_programs() {
    use std::os::unix::fs::PermissionsExt;
    let (d, repo) = empty();
    write(d.path(), "a.mdx", "a\n");
    repo.stage(&paths(&["a.mdx"])).unwrap();
    repo.commit("init").unwrap();
    let marker = d.path().join("ran");
    let script = d.path().join(".git/evil.sh");
    fs::write(&script, format!("#!/bin/sh\ntouch '{}'\n", marker.display())).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    for key in ["core.fsmonitor", "diff.external", "diff.mdx.textconv"] {
        git(d.path(), &["config", key, script.to_str().unwrap()]);
    }
    write(d.path(), ".gitattributes", "*.mdx diff=mdx\n");
    write(d.path(), "a.mdx", "changed\n");
    repo.status().unwrap();
    repo.diff("a.mdx", false).unwrap();
    repo.blame("a.mdx", "changed\n").unwrap();
    repo.branches().unwrap();
    assert!(!marker.exists());
}

/// A bare repository standing in for the server, and a clone with one pushed commit.
fn with_remote() -> (tempfile::TempDir, tempfile::TempDir, Repo) {
    let server = tempfile::tempdir().unwrap();
    git(server.path(), &["init", "-q", "--bare"]);
    git(server.path(), &["symbolic-ref", "HEAD", "refs/heads/main"]);
    let (dir, repo) = empty();
    git(dir.path(), &["remote", "add", "origin", server.path().to_str().unwrap()]);
    commit_file(dir.path(), &repo, "a.mdx", "one\n");
    repo.push().unwrap();
    (server, dir, repo)
}

fn commit_file(dir: &Path, repo: &Repo, path: &str, text: &str) {
    write(dir, path, text);
    repo.stage(&paths(&[path])).unwrap();
    repo.commit(path).unwrap();
}

/// Another person's clone of the server.
fn colleague(server: &Path) -> (tempfile::TempDir, Repo) {
    let (dir, repo) = empty();
    git(dir.path(), &["remote", "add", "origin", server.to_str().unwrap()]);
    git(dir.path(), &["fetch", "-q", "origin"]);
    git(dir.path(), &["reset", "-q", "--hard", "origin/main"]);
    git(dir.path(), &["branch", "-q", "--set-upstream-to=origin/main"]);
    (dir, repo)
}

fn server_log(server: &Path, branch: &str) -> String {
    let out = Command::new("git").current_dir(server).args(["log", "--format=%s", branch]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).replace('\n', " ").trim().to_owned()
}

#[test]
fn publishes_then_pushes_and_never_forces() {
    let (server, dir, repo) = with_remote();
    let status = repo.status().unwrap();
    assert_eq!((status.upstream.as_deref(), status.ahead, status.remotes), (Some("origin/main"), 0, vec!["origin".to_owned()]));

    commit_file(dir.path(), &repo, "b.mdx", "two\n");
    assert_eq!(repo.push().unwrap(), Pushed { target: "origin/main".into(), published: false, commits: 1 });
    assert_eq!(server_log(server.path(), "main"), "b.mdx a.mdx");

    // A new branch is published and starts tracking.
    repo.create_branch("test").unwrap();
    commit_file(dir.path(), &repo, "c.mdx", "three\n");
    assert_eq!(repo.push().unwrap(), Pushed { target: "origin/test".into(), published: true, commits: 0 });
    assert_eq!(repo.status().unwrap().upstream.as_deref(), Some("origin/test"));
    assert_eq!(server_log(server.path(), "test"), "c.mdx b.mdx a.mdx");
    assert_eq!(server_log(server.path(), "main"), "b.mdx a.mdx");

    // Someone else got there first: the push is rejected and their commit survives.
    repo.switch("main").unwrap();
    let (other_dir, other) = colleague(server.path());
    commit_file(other_dir.path(), &other, "theirs.mdx", "x\n");
    other.push().unwrap();
    commit_file(dir.path(), &repo, "mine.mdx", "y\n");
    assert!(repo.push().unwrap_err().to_string().contains("rejected"));
    assert_eq!(server_log(server.path(), "main"), "theirs.mdx b.mdx a.mdx");
}

#[test]
fn fetches_and_only_fast_forwards() {
    let (server, dir, repo) = with_remote();
    assert_eq!(repo.pull().unwrap(), 0);
    let (other_dir, other) = colleague(server.path());
    commit_file(other_dir.path(), &other, "theirs.mdx", "x\n");
    other.push().unwrap();

    assert_eq!(repo.status().unwrap().behind, 0);
    repo.fetch().unwrap();
    assert_eq!(repo.status().unwrap().behind, 1);
    assert!(!dir.path().join("theirs.mdx").exists());
    assert_eq!(repo.pull().unwrap(), 1);
    assert!(dir.path().join("theirs.mdx").exists());

    // Uncommitted work that the pull would overwrite is kept.
    commit_file(other_dir.path(), &other, "a.mdx", "their edit\n");
    other.push().unwrap();
    write(dir.path(), "a.mdx", "my uncommitted edit\n");
    assert!(repo.pull().is_err());
    assert_eq!(fs::read_to_string(dir.path().join("a.mdx")).unwrap(), "my uncommitted edit\n");
    git(dir.path(), &["checkout", "-q", "--", "a.mdx"]);

    // Diverged histories are left alone, whatever pull.rebase says.
    git(dir.path(), &["config", "pull.rebase", "true"]);
    commit_file(dir.path(), &repo, "mine.mdx", "y\n");
    let head = repo.status().unwrap().head;
    assert!(repo.pull().unwrap_err().to_string().contains("1 local"));
    assert_eq!(repo.status().unwrap().head, head);
}

#[test]
fn notices_a_deleted_upstream_and_publishes_again() {
    let (server, dir, repo) = with_remote();
    repo.create_branch("gone").unwrap();
    commit_file(dir.path(), &repo, "g.mdx", "g\n");
    repo.push().unwrap();
    git(server.path(), &["branch", "-q", "-D", "gone"]);
    repo.fetch().unwrap();
    assert!(repo.status().unwrap().upstream_gone);
    assert!(repo.pull().unwrap_err().to_string().contains("no longer exists"));
    assert!(repo.push().unwrap().published);
    assert!(!repo.status().unwrap().upstream_gone);
}

#[test]
fn explains_why_it_cannot_talk_to_a_remote() {
    let (dir, repo) = empty();
    assert!(repo.push().unwrap_err().to_string().contains("commit first"));
    commit_file(dir.path(), &repo, "a.mdx", "a\n");
    for error in [repo.push().map(|_| ()), repo.fetch()] {
        assert!(error.unwrap_err().to_string().contains("git remote add"));
    }
    assert!(repo.pull().unwrap_err().to_string().contains("no upstream"));

    let (_server, dir, repo) = with_remote();
    // A branch started from origin/main must not push into main.
    git(dir.path(), &["switch", "-q", "-c", "feature", "--track", "origin/main"]);
    assert!(repo.push().unwrap_err().to_string().contains("different name"));
    git(dir.path(), &["checkout", "-q", "--detach"]);
    assert!(repo.push().unwrap_err().to_string().contains("detached"));
    // An unreachable remote reports git's reason.
    git(dir.path(), &["remote", "set-url", "origin", "/nonexistent/repo"]);
    assert!(repo.fetch().is_err());
}
