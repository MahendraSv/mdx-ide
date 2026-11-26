//! Discarding unstaged changes.
//!
//! This destroys work, so it is deliberately narrow:
//!
//! * only paths git currently reports as having unstaged changes are accepted;
//! * tracked files are restored from the index, so staged changes survive;
//! * files git has no copy of (untracked, or only `git add -N`) go to the system Trash;
//! * conflicted files and folders are refused;
//! * everything is checked before anything is touched.

use std::path::Path;

use crate::{check_path, GitError, Repo, Result};

impl Repo {
    pub fn discard(&self, paths: &[String]) -> Result<()> {
        self.discard_with(paths, move_to_trash)
    }

    /// [`Repo::discard`] with a chosen way of removing files git cannot restore.
    pub(crate) fn discard_with(&self, paths: &[String], mut remove: impl FnMut(&Path) -> Result<()>) -> Result<()> {
        let status = self.status()?;
        let mut restore = Vec::new();
        let mut untracked = Vec::new();
        // Intent-to-add: in the index with no content, so "restoring" it would empty the file.
        let mut intended = Vec::new();
        for path in paths {
            check_path(path)?;
            let file = status.files.iter().find(|f| &f.path == path);
            match file.map(|f| (f.conflicted, f.unstaged)) {
                Some((true, _)) => return Err(GitError::Invalid(format!("{path} has a conflict; resolve it instead of discarding"))),
                Some((false, Some(code @ ('U' | 'A')))) => {
                    let full = self.top.join(path);
                    let meta = full.symlink_metadata().map_err(|e| GitError::Failed(format!("could not read {path}: {e}")))?;
                    // git lists a nested repository as a single untracked folder.
                    if meta.is_dir() {
                        return Err(GitError::Invalid(format!("{path} is a folder (perhaps another repository); remove it yourself")));
                    }
                    // A symlinked parent folder must not lead outside the repository.
                    let parent = full.parent().and_then(|p| p.canonicalize().ok());
                    if !parent.is_some_and(|p| self.top.canonicalize().is_ok_and(|top| p.starts_with(top))) {
                        return Err(GitError::Invalid(format!("{path} is outside the repository")));
                    }
                    untracked.push(full);
                    if code == 'A' {
                        intended.push(path.clone());
                    }
                }
                Some((false, Some(_))) => restore.push(path.clone()),
                _ => return Err(GitError::Invalid(format!("{path} has no unstaged changes"))),
            }
        }

        self.with_paths(&["restore", "--worktree"], &restore)?;
        for full in &untracked {
            remove(full)?;
        }
        self.with_paths(&["rm", "--cached", "--force", "--quiet"], &intended)
    }
}

fn move_to_trash(path: &Path) -> Result<()> {
    #[allow(unused_mut)]
    let mut context = trash::TrashContext::new();
    // The default macOS method scripts Finder, which prompts for automation permission.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        context.set_delete_method(DeleteMethod::NsFileManager);
    }
    context.delete(path).map_err(|e| GitError::Failed(format!("could not move {} to the Trash: {e}", path.display())))
}
