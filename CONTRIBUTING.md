# Contributing to notebooklm-chunker

Thanks for your interest in contributing! This document provides guidelines for contributing to the project.

## Development Setup

1. Clone the repository:
```bash
git clone https://github.com/cmlonder/notebooklm-chunker.git
cd notebooklm-chunker
```

2. Create a virtual environment:
```bash
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
```

3. Install in editable mode with dev dependencies:
```bash
pip install -e ".[dev]"
```

## Code Quality

Before submitting a PR, ensure your code passes all checks:

### Linting and Formatting
```bash
ruff check .
ruff format .
```

### Type Checking
```bash
mypy notebooklm_chunker
```

### Tests
```bash
python -m unittest discover -s tests -v
```

### Coverage
```bash
coverage run -m unittest discover -s tests -v
coverage report
```

The project requires minimum 80% line coverage.

### Full Check
```bash
ruff check . && ruff format --check . && mypy notebooklm_chunker && coverage run -m unittest discover -s tests -v && coverage report
```

## Testing

- Add tests for new features or bug fixes
- Place tests in the `tests/` directory
- Follow existing test patterns
- Ensure all tests pass before submitting

## Pull Request Process

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run all quality checks locally
5. Commit with clear, descriptive messages
6. Push to your fork
7. Open a PR against `main`

### PR Guidelines

- Provide a clear description of the changes
- Reference any related issues
- Ensure CI passes
- Keep PRs focused on a single concern
- Update documentation if needed

## Code Style

- Follow PEP 8 (enforced by ruff)
- Use type hints where practical
- Write clear docstrings for public APIs
- Keep functions focused and testable

## Commit Messages

- Use clear, descriptive commit messages
- Start with a verb in present tense
- Keep the first line under 72 characters
- Add details in the body if needed

Example:
```
Add dry-run mode for workflow preview

- Show chunk count and skip ranges
- Display Studio jobs without execution
- Add --dry-run flag to CLI
```

## Questions or Issues?

- Open an issue for bugs or feature requests
- Use discussions for questions
- Check existing issues before creating new ones

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
