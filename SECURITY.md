# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in notebooklm-chunker, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainer directly or use GitHub's private vulnerability reporting
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and work with you to address the issue.

## Security Considerations

### Dependency Security

This project uses:
- `notebooklm-py[browser]` for NotebookLM API interaction
- `pymupdf` for PDF parsing

Both dependencies are regularly updated. Run `pip-audit` to check for known vulnerabilities:

```bash
pip install pip-audit
pip-audit
```

### File Handling

- PDF files are parsed locally using PyMuPDF
- No PDF content is sent anywhere except to NotebookLM via the official API
- Output directories should have appropriate permissions

### API Credentials

- NotebookLM credentials are managed by `notebooklm-py`
- Never commit credentials or session data to version control
- Use environment variables or secure credential storage

### Secret Scanning

- This repository uses GitHub's secret scanning
- Avoid committing sensitive data in:
  - Configuration files
  - Test fixtures
  - Example workflows
  - Run state files

### Supply Chain

- Dependencies are pinned with minimum versions
- GitHub Actions are pinned to major versions
- Dependabot monitors for updates

## Best Practices for Users

1. Keep the package updated to the latest version
2. Review workflow files before running them
3. Use virtual environments to isolate dependencies
4. Verify downloaded artifacts before execution
5. Be cautious with untrusted PDF files

## Disclosure Policy

- Security issues will be disclosed after a fix is available
- Credit will be given to reporters (unless anonymity is requested)
- CVEs will be requested for significant vulnerabilities
