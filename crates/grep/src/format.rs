use crate::types::RgCount;

#[derive(Debug, Clone, Copy)]
pub struct ZeroMatchContext<'a> {
    pub case_insensitive: bool,
    pub glob: Option<&'a str>,
    pub r#type: Option<&'a str>,
}

fn zero_match_hint(ctx: ZeroMatchContext) -> String {
    let mut suggestions: Vec<String> = Vec::new();
    if !ctx.case_insensitive {
        suggestions.push("case_insensitive: true".to_string());
    }
    if let Some(g) = ctx.glob {
        suggestions.push(format!("remove glob='{}'", g));
    }
    if let Some(t) = ctx.r#type {
        suggestions.push(format!("remove type='{}'", t));
    }
    suggestions.push("broaden the pattern".to_string());
    suggestions.push("try a different path".to_string());
    format!("(No files matched. Try: {}.)", suggestions.join("; "))
}

fn kb_label(bytes: usize) -> String {
    format!("{} KB", bytes / 1024)
}

pub struct FilesBlock<'a> {
    pub pattern: &'a str,
    pub paths: &'a [String],
    pub total: usize,
    pub offset: usize,
    pub more: bool,
    pub zero_match_context: ZeroMatchContext<'a>,
}

pub fn format_files_with_matches(p: FilesBlock) -> String {
    let header = format!("<pattern>{}</pattern>\n<matches>", p.pattern);
    if p.paths.is_empty() {
        let hint = zero_match_hint(p.zero_match_context);
        return format!("{}\n{}\n</matches>", header, hint);
    }
    let body = p.paths.join("\n");
    let next = p.offset + p.paths.len();
    let hint = if p.more {
        format!(
            "(Showing files {}-{} of {}. Next offset: {}.)",
            p.offset + 1,
            next,
            p.total,
            next
        )
    } else {
        format!("(Found {} file(s) matching the pattern.)", p.total)
    };
    format!("{}\n{}\n\n{}\n</matches>", header, body, hint)
}

pub struct ContentLine<'a> {
    pub path: &'a str,
    pub line: u64,
    pub text: &'a str,
}

pub struct ContentBlock<'a> {
    pub pattern: &'a str,
    pub matches: &'a [ContentLine<'a>],
    pub total_matches: usize,
    pub offset: usize,
    pub more: bool,
    pub byte_cap: bool,
    pub max_bytes: usize,
    pub zero_match_context: ZeroMatchContext<'a>,
}

pub fn format_content(p: ContentBlock) -> String {
    let header = format!("<pattern>{}</pattern>\n<matches>", p.pattern);
    if p.matches.is_empty() {
        let hint = zero_match_hint(p.zero_match_context).replace("No files matched", "No matches");
        return format!("{}\n{}\n</matches>", header, hint);
    }
    let mut chunks: Vec<String> = Vec::new();
    let mut current: &str = "";
    for m in p.matches {
        if m.path != current {
            if !current.is_empty() {
                chunks.push(String::new());
            }
            chunks.push(m.path.to_string());
            current = m.path;
        }
        chunks.push(format!("  {}: {}", m.line, m.text));
    }
    let body = chunks.join("\n");
    let next = p.offset + p.matches.len();
    let hint = if p.byte_cap {
        format!(
            "(Output capped at {}. Showing matches {}-{} of {}. Next offset: {}.)",
            kb_label(p.max_bytes),
            p.offset + 1,
            next,
            p.total_matches,
            next
        )
    } else if p.more {
        format!(
            "(Showing matches {}-{} of {}. Next offset: {}.)",
            p.offset + 1,
            next,
            p.total_matches,
            next
        )
    } else {
        let file_count: std::collections::HashSet<&str> =
            p.matches.iter().map(|m| m.path).collect();
        format!(
            "(Found {} match(es) across {} file(s).)",
            p.total_matches,
            file_count.len()
        )
    };
    format!("{}\n{}\n\n{}\n</matches>", header, body, hint)
}

pub struct CountBlock<'a> {
    pub pattern: &'a str,
    pub counts: &'a [RgCount],
    pub total: usize,
    pub offset: usize,
    pub more: bool,
    pub zero_match_context: ZeroMatchContext<'a>,
}

pub fn format_count(p: CountBlock) -> String {
    let header = format!("<pattern>{}</pattern>\n<counts>", p.pattern);
    if p.counts.is_empty() {
        let hint = zero_match_hint(p.zero_match_context).replace("No files matched", "No matches");
        return format!("{}\n{}\n</counts>", header, hint);
    }
    let body = p
        .counts
        .iter()
        .map(|c| format!("{}: {}", c.path, c.count))
        .collect::<Vec<_>>()
        .join("\n");
    let next = p.offset + p.counts.len();
    let hint = if p.more {
        format!(
            "(Showing files {}-{} of {}. Next offset: {}.)",
            p.offset + 1,
            next,
            p.total,
            next
        )
    } else {
        format!("({} file(s) with matches. Count complete. For an existence or file-count question, answer from these counts; matching text is not needed.)", p.total)
    };
    format!("{}\n{}\n\n{}\n</counts>", header, body, hint)
}
