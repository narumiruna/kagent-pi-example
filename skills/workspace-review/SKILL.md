---
name: workspace-review
description: Inspects and reviews a source-code workspace using read, grep, find, and ls. Use when asked to explain repository structure, locate implementations, review changes, or assess code quality.
---

# Workspace review

1. Start with `find` or `ls` to understand the repository layout.
2. Use `grep` to locate relevant symbols and `read` to inspect focused sections.
3. Do not use `bash` merely to read files when a narrower read-only tool is available.
4. Separate observed facts from recommendations.
5. Before proposing a code change, identify affected tests and configuration.
6. Do not modify files unless the user explicitly asks for changes.
