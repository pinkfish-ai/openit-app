//! Claude CLI integrations beyond the interactive PTY session — currently
//! the `Generate commit message` sparkle in the source-control panel.
//!
//! We shell out to the user's existing `claude` install (same auth path as
//! their interactive sessions) in non-interactive `-p` mode, with a hard
//! timeout so a hung CLI can't outlive the spinner.

use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Cap on the staged diff we send to Claude. Big diffs (e.g. an initial
/// import) would otherwise blow past the model's context budget — we'd
/// rather get a slightly less specific message than no message.
const MAX_DIFF_BYTES: usize = 12_000;

/// How many recent subjects to send as style examples.
const RECENT_LOG_COUNT: usize = 10;

/// Hard timeout for the Claude call. Sonnet usually answers in 2–5s; a
/// minute is generous-but-bounded.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(60);

fn run_git(repo: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(["-C", repo])
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))
}

fn truncate_at_char_boundary(s: &mut String, max: usize) {
    if s.len() <= max {
        return;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push_str("\n…(truncated)\n");
}

/// Generate a one-line commit subject for the currently staged diff using
/// Claude in `-p` print mode. Returns the trimmed first non-empty line of
/// Claude's output, or an error string suitable for surfacing in a toast.
///
/// `async` + `spawn_blocking` is intentional: Tauri runs sync commands on
/// the main thread, so a 5–30s `claude` invocation would freeze the
/// renderer (cursor turns into the OS busy spinner, our CSS spinner never
/// repaints). Wrapping in `spawn_blocking` keeps the UI responsive.
#[tauri::command]
pub async fn claude_generate_commit_message(repo: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || generate_commit_message_blocking(&repo))
        .await
        .map_err(|e| format!("background task failed: {}", e))?
}

fn generate_commit_message_blocking(repo: &str) -> Result<String, String> {
    let claude = which::which("claude")
        .map_err(|_| "Claude CLI not found on PATH".to_string())?;

    let diff_out = run_git(repo, &["diff", "--cached"])?;
    if !diff_out.status.success() {
        return Err(String::from_utf8_lossy(&diff_out.stderr).into_owned());
    }
    let mut diff_text = String::from_utf8_lossy(&diff_out.stdout).into_owned();
    if diff_text.trim().is_empty() {
        return Err("Nothing staged — stage some changes first.".to_string());
    }
    truncate_at_char_boundary(&mut diff_text, MAX_DIFF_BYTES);

    let log_out = run_git(
        repo,
        &[
            "log",
            "-n",
            &RECENT_LOG_COUNT.to_string(),
            "--format=%s",
        ],
    )?;
    let recent = String::from_utf8_lossy(&log_out.stdout)
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| format!("- {}", l))
        .collect::<Vec<_>>()
        .join("\n");
    let recent_block = if recent.is_empty() {
        "(no prior commits in this repo — pick a sensible style)".to_string()
    } else {
        recent
    };

    let prompt = format!(
        "You write concise git commit subject lines that match the project's existing style.\n\n\
Recent commit subjects (most recent first):\n\
{}\n\n\
Generate ONE commit subject line for this staged diff. Match the style above (e.g. Conventional Commits if used). Keep it ≤72 characters.\n\n\
Staged diff:\n\
```\n\
{}\n\
```\n\n\
Output ONLY the subject line. No quotes, no code fences, no explanation, no preamble.",
        recent_block, diff_text
    );

    let mut child = Command::new(&claude)
        .arg("-p")
        .arg(&prompt)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {}", e))?;

    // Poll for completion with a hard timeout. Avoids a hung claude
    // outliving the spinner.
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if started.elapsed() > CLAUDE_TIMEOUT {
                    let _ = child.kill();
                    return Err(format!(
                        "Claude timed out after {}s",
                        CLAUDE_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(format!("waiting on claude: {}", e)),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("collecting claude output: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude exited {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`')
        .to_string();

    if line.is_empty() {
        return Err("Claude returned an empty message".to_string());
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_strings_intact() {
        let mut s = "hello".to_string();
        truncate_at_char_boundary(&mut s, 100);
        assert_eq!(s, "hello");
    }

    #[test]
    fn truncate_handles_multibyte_boundaries() {
        // Each `é` is 2 bytes; truncate point lands mid-char.
        let mut s = "éééééé".to_string(); // 12 bytes
        truncate_at_char_boundary(&mut s, 5);
        // Should not panic and should produce a valid utf-8 string with
        // the truncation marker appended.
        assert!(s.is_char_boundary(s.len()));
        assert!(s.contains("(truncated)"));
    }

    #[test]
    fn errors_when_nothing_staged_or_claude_missing() {
        // Test the blocking inner directly — the public command is async and
        // delegates straight through.
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_string_lossy().to_string();
        let _ = Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir.path())
            .output();
        let res = generate_commit_message_blocking(&p);
        // Either "Nothing staged" (claude exists) or "Claude CLI not found"
        // (it doesn't). Both are valid error returns; both are non-panicking.
        assert!(res.is_err());
    }
}
