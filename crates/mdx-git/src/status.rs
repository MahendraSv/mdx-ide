//! Parsing `git status --porcelain=v2 --branch -z`.

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Abbreviated HEAD commit; `None` before the first commit.
    pub head: Option<String>,
    pub upstream: Option<String>,
    /// The upstream branch is configured but no longer exists.
    pub upstream_gone: bool,
    /// Names of the configured remotes.
    pub remotes: Vec<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Previous path of a rename or copy.
    pub orig_path: Option<String>,
    /// Change in the index relative to HEAD: `M`, `A`, `D`, `R`, `C`, `T`.
    pub staged: Option<char>,
    /// Change in the working tree relative to the index, or `U` for untracked.
    pub unstaged: Option<char>,
    pub conflicted: bool,
}

pub(crate) fn parse(output: &[u8]) -> Status {
    let text = String::from_utf8_lossy(output);
    let mut status = Status::default();
    let mut records = text.split('\0');
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            header_line(&mut status, header);
            continue;
        }
        let Some((kind, rest)) = record.split_once(' ') else { continue };
        // Fields before the path; the path itself may contain spaces.
        let fields = match kind {
            "1" => 7,
            "2" => 8,
            "u" => 9,
            "?" => {
                status.files.push(ChangedFile {
                    path: rest.to_owned(),
                    orig_path: None,
                    staged: None,
                    unstaged: Some('U'),
                    conflicted: false,
                });
                continue;
            }
            _ => continue,
        };
        let mut parts = rest.splitn(fields + 1, ' ');
        let mut xy = parts.next().unwrap_or("..").chars();
        let code = |c: Option<char>| c.filter(|&c| c != '.');
        let (x, y) = (code(xy.next()), code(xy.next()));
        let Some(path) = parts.nth(fields - 1) else { continue };
        let conflicted = kind == "u";
        status.files.push(ChangedFile {
            path: path.to_owned(),
            // A rename is followed by its source as a record of its own.
            orig_path: (kind == "2").then(|| records.next().unwrap_or_default().to_owned()),
            staged: x.filter(|_| !conflicted),
            unstaged: y.filter(|_| !conflicted),
            conflicted,
        });
    }
    // git only reports ahead/behind when the upstream branch exists.
    status.upstream_gone = status.upstream.is_some() && !text.contains("# branch.ab ");
    status.files.sort_by(|a, b| a.path.cmp(&b.path));
    status
}

fn header_line(status: &mut Status, header: &str) {
    let Some((key, value)) = header.split_once(' ') else { return };
    match key {
        "branch.oid" if value != "(initial)" => status.head = Some(value.chars().take(7).collect()),
        "branch.head" if value != "(detached)" => status.branch = Some(value.to_owned()),
        "branch.upstream" => status.upstream = Some(value.to_owned()),
        "branch.ab" => {
            for part in value.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    status.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    status.behind = n.parse().unwrap_or(0);
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_record_kind() {
        let out = "# branch.oid 0123456789abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
                   1 MM N... 100644 100644 100644 aaa bbb a file.mdx\0\
                   2 R. N... 100644 100644 100644 aaa bbb R100 new name.mdx\0old name.mdx\0\
                   u UU N... 100644 100644 100644 100644 aaa bbb ccc clash.mdx\0\
                   ? notes/ñ.mdx\0! ignored.mdx\0";
        let s = parse(out.as_bytes());
        assert_eq!((s.branch.as_deref(), s.head.as_deref(), s.ahead, s.behind), (Some("main"), Some("0123456"), 2, 1));
        let summary: Vec<_> = s.files.iter().map(|f| (f.path.as_str(), f.staged, f.unstaged, f.conflicted)).collect();
        assert_eq!(
            summary,
            vec![
                ("a file.mdx", Some('M'), Some('M'), false),
                ("clash.mdx", None, None, true),
                ("new name.mdx", Some('R'), None, false),
                ("notes/ñ.mdx", None, Some('U'), false),
            ]
        );
        assert_eq!(s.files[2].orig_path.as_deref(), Some("old name.mdx"));
        assert!(!s.upstream_gone);
        assert!(parse(b"# branch.head x\0# branch.upstream origin/x\0").upstream_gone);
    }
}
