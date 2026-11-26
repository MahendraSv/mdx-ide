//! Lightweight extraction of local names bound by `import` statements.
//!
//! This is deliberately a tiny scanner rather than a JS parser: mdxjs has
//! already validated the ESM with SWC at compile time, and here we only
//! need the names to avoid "unknown component" false positives.

/// `import A, { B, C as D } from 'x'` → `["A", "B", "D"]`;
/// `import * as NS from 'x'` → `["NS"]`; side-effect imports → `[]`.
pub fn imported_names(esm: &str) -> Vec<String> {
    let mut names = Vec::new();
    for statement in esm
        .split(';')
        .flat_map(|s| s.split("\nimport ").enumerate().map(|(i, part)| if i == 0 { part.to_owned() } else { format!("import {part}") }))
    {
        let statement = statement.trim();
        let Some(rest) = statement.strip_prefix("import") else { continue };
        let rest = rest.trim_start();
        let Some(idx) = find_from(rest) else { continue };
        let clause = rest[..idx].trim();
        let clause = clause.strip_prefix("type ").unwrap_or(clause);
        names.extend(parse_clause(clause));
    }
    names
}

fn find_from(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let bytes = s.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'{' => depth += 1,
            b'}' => depth -= 1,
            b'f' if depth == 0 && s[i..].starts_with("from") => {
                let before_ok = i == 0 || bytes[i - 1].is_ascii_whitespace() || bytes[i - 1] == b'}';
                let after_ok = bytes.get(i + 4).is_none_or(|c| c.is_ascii_whitespace() || *c == b'\'' || *c == b'"');
                if before_ok && after_ok {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_clause(clause: &str) -> Vec<String> {
    let mut out = Vec::new();
    let (outside, inside) = match (clause.find('{'), clause.rfind('}')) {
        (Some(a), Some(b)) if a < b => (format!("{}{}", &clause[..a], &clause[b + 1..]), Some(&clause[a + 1..b])),
        _ => (clause.to_owned(), None),
    };
    for part in outside.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        // `* as NS` or default import `A`
        out.push(part.rsplit(char::is_whitespace).next().unwrap_or(part).to_owned());
    }
    if let Some(inside) = inside {
        for part in inside.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let part = part.strip_prefix("type ").unwrap_or(part);
            out.push(part.rsplit(" as ").next().unwrap_or(part).trim().to_owned());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::imported_names;

    #[test]
    fn forms() {
        assert_eq!(imported_names("import Chart from './Chart.tsx'"), vec!["Chart"]);
        assert_eq!(
            imported_names("import A, { B, C as D } from \"@team/ui\";\nimport * as NS from 'ns'\nimport './side-effect.css'"),
            vec!["A", "B", "D", "NS"]
        );
        assert_eq!(imported_names("import {\n  Tabs,\n  Tab,\n} from '@team/ui'"), vec!["Tabs", "Tab"]);
        assert!(imported_names("export const meta = {}").is_empty());
    }
}
