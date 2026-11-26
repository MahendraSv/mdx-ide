//! Workspace full-text search over `.mdx` files.
//!
//! Plain regex over files found by `ignore` (ripgrep's walker). Good enough
//! for docs repos with thousands of files; swap in the `grep-searcher` crate
//! if you need ripgrep's mmap/binary-detection speed.

use regex::RegexBuilder;
use serde::{Deserialize, Serialize};

use crate::{Workspace, WorkspaceError};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchOptions {
    pub query: String,
    pub regex: bool,
    pub case_sensitive: bool,
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    /// 1-based.
    pub line: usize,
    /// 1-based, in characters.
    pub column: usize,
    pub preview: String,
}

pub fn search(ws: &Workspace, opts: &SearchOptions) -> Result<Vec<SearchHit>, WorkspaceError> {
    if opts.query.is_empty() {
        return Ok(vec![]);
    }
    let pattern = if opts.regex { opts.query.clone() } else { regex::escape(&opts.query) };
    let re = RegexBuilder::new(&pattern).case_insensitive(!opts.case_sensitive).build()?;
    let max = opts.max_results.unwrap_or(500);

    let mut hits = Vec::new();
    for file in ws.mdx_files() {
        let Ok(text) = std::fs::read_to_string(ws.root().join(&file.path)) else { continue };
        for (i, line) in text.lines().enumerate() {
            if let Some(m) = re.find(line) {
                hits.push(SearchHit {
                    path: file.path.clone(),
                    line: i + 1,
                    column: line[..m.start()].chars().count() + 1,
                    preview: line.trim().chars().take(200).collect(),
                });
                if hits.len() >= max {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}
