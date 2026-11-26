use std::collections::HashMap;

/// GitHub-style heading slugger (same algorithm as `github-slugger`, which
/// Docusaurus, Next.js docs themes and `rehype-slug` use).
///
/// Duplicates get `-1`, `-2`, ... suffixes, so one slugger must be used per
/// document, in document order.
#[derive(Debug, Default)]
pub struct Slugger {
    seen: HashMap<String, usize>,
}

impl Slugger {
    pub fn slug(&mut self, text: &str) -> String {
        let base = slugify(text);
        let mut candidate = base.clone();
        while let Some(count) = self.seen.get_mut(&candidate) {
            *count += 1;
            candidate = format!("{base}-{count}");
        }
        self.seen.insert(candidate.clone(), 0);
        candidate
    }
}

pub fn slugify(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            '-' | '_' => Some(c),
            c if c.is_alphanumeric() => Some(c),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_style() {
        let mut s = Slugger::default();
        assert_eq!(s.slug("Hello, World!"), "hello-world");
        assert_eq!(s.slug("Hello World"), "hello-world-1");
        assert_eq!(s.slug("Hello World"), "hello-world-2");
        assert_eq!(s.slug("API v2 (beta)"), "api-v2-beta");
        assert_eq!(s.slug("snake_case title"), "snake_case-title");
    }
}
