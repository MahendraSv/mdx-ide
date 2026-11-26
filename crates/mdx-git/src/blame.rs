//! Parsing `git blame --porcelain`.

use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameCommit {
    /// Abbreviated id; `None` for lines not committed yet.
    pub id: Option<String>,
    pub author: String,
    /// Seconds since the Unix epoch.
    pub time: i64,
    pub summary: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blame {
    pub commits: Vec<BlameCommit>,
    /// For each line, in order, an index into `commits`.
    pub lines: Vec<usize>,
}

impl Blame {
    pub(crate) fn uncommitted(lines: usize) -> Blame {
        let commit = BlameCommit { id: None, author: "You".into(), time: 0, summary: "Not committed yet".into() };
        Blame { commits: vec![commit], lines: vec![0; lines] }
    }
}

pub(crate) fn parse(output: &str) -> Blame {
    let mut blame = Blame::default();
    let mut known: HashMap<&str, usize> = HashMap::new();
    let mut current = 0;
    for line in output.lines() {
        // Content lines start with a tab and end each entry.
        if line.starts_with('\t') {
            blame.lines.push(current);
            continue;
        }
        let (key, value) = line.split_once(' ').unwrap_or((line, ""));
        if key.len() >= 40 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
            current = *known.entry(key).or_insert_with(|| {
                let id = (!key.bytes().all(|b| b == b'0')).then(|| key[..7].to_owned());
                blame.commits.push(BlameCommit { id, author: String::new(), time: 0, summary: String::new() });
                blame.commits.len() - 1
            });
            continue;
        }
        let Some(commit) = blame.commits.get_mut(current) else { continue };
        match key {
            "author" => commit.author = value.to_owned(),
            "author-time" => commit.time = value.parse().unwrap_or(0),
            "summary" => commit.summary = value.to_owned(),
            _ => {}
        }
        // git describes edited lines as "Not Committed Yet" by an external author.
        if commit.id.is_none() {
            commit.author = "You".into();
            commit.time = 0;
            commit.summary = "Not committed yet".into();
        }
    }
    blame
}
