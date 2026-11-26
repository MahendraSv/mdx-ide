//! Runs the full analysis against `examples/docs-site` so the example and
//! the checks can't drift apart.

use mdx_workspace::Workspace;

fn example() -> Workspace {
    Workspace::open(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/docs-site")).unwrap()
}

#[test]
fn clean_pages_have_no_problems() {
    let ws = example();
    for page in ["docs/intro.mdx", "docs/guides/installation.mdx"] {
        let a = ws.analyze(page, &ws.read(page).unwrap());
        assert!(a.diagnostics.is_empty(), "{page}: {:#?}", a.diagnostics);
        mdx_compile::compile(&ws.read(page).unwrap(), &Default::default()).unwrap();
    }
}

#[test]
fn broken_example_reports_every_kind_of_problem() {
    let ws = example();
    let page = "docs/blog/broken-example.mdx";
    let a = ws.analyze(page, &ws.read(page).unwrap());
    let mut rules: Vec<&str> = a.diagnostics.iter().map(|d| d.rule.as_str()).collect();
    rules.sort();
    rules.dedup();
    assert_eq!(
        rules,
        vec![
            "broken-anchor",
            "broken-link",
            "frontmatter-schema",
            "image-alt",
            "invalid-prop-value",
            "missing-required-prop",
            "unknown-component",
        ],
        "{:#?}",
        a.diagnostics
    );
}

#[test]
fn custom_components_example_loads() {
    let ws = Workspace::open(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/custom-components")).unwrap();
    assert!(ws.config_diagnostics.is_empty(), "{:?}", ws.config_diagnostics);
    assert_eq!(ws.manifest.as_ref().map(|m| m.components.len()), Some(2));
    let source = ws.read("docs/check.mdx").unwrap();
    let diagnostics = ws.analyze("docs/check.mdx", &source).diagnostics;
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
}

/// Reorganising the example docs must not break any link that worked before.
#[test]
fn moving_example_pages_keeps_links_working() {
    fn copy(from: &std::path::Path, to: &std::path::Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    fn broken(ws: &Workspace) -> usize {
        ws.mdx_files()
            .iter()
            .flat_map(|f| ws.analyze(&f.path, &ws.read(&f.path).unwrap()).diagnostics)
            .filter(|d| d.rule.starts_with("broken"))
            .count()
    }
    let dir = tempfile::tempdir().unwrap();
    copy(std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/docs-site")), dir.path());
    let ws = Workspace::open(dir.path()).unwrap();
    let before = broken(&ws);
    assert!(before > 0, "the example has deliberately broken links");

    let mut updated = 0;
    for (from, to) in [
        ("docs/guides/installation.mdx", "docs/guides/setup.mdx"),
        ("docs/guides", "docs/start/here"),
        ("docs/intro.mdx", "docs/start/welcome.mdx"),
        ("docs/blog", "docs/start/here/news"),
    ] {
        let report = ws.rename_updating_links(from, to, &Default::default()).unwrap();
        assert!(report.skipped.is_empty(), "{:?}", report.skipped);
        updated += report.files.iter().map(|f| f.links).sum::<usize>();
        assert_eq!(broken(&ws), before, "after moving {from} to {to}");
    }
    assert!(updated >= 3, "only {updated} links updated");
}
