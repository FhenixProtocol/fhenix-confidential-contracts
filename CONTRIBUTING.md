# Contributing to Fhenix Confidential Contracts

Thank you for your interest in contributing to Fhenix Confidential Contracts! This document provides guidelines for contributing to this project.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment. We expect all contributors to:

- Use welcoming and inclusive language
- Be respectful of differing viewpoints and experiences
- Accept constructive criticism gracefully
- Focus on what is best for the community

## How to Contribute

### Reporting Issues

Before opening an issue:

1. **Search existing issues** to avoid duplicates
2. **Check closed issues** - your problem may have been resolved

When creating an issue:

- Use a clear and descriptive title
- Provide detailed reproduction steps
- Include relevant code snippets
- Specify your environment (Solidity version, Node.js version, etc.)

### Security Vulnerabilities

**DO NOT** open a public issue for security vulnerabilities. Please use [GitHub Security Advisories](https://github.com/FhenixProtocol/fhenix-confidential-contracts/security/advisories/new) instead.

### Feature Requests

Feature requests are welcome! Please:

1. Explain the use case in detail
2. Describe the expected behavior
3. Consider if it aligns with the project's goals

### Pull Request Process

#### Before Starting Work

1. **Open an issue first** for non-trivial changes
2. **Discuss the approach** with maintainers
3. **Check that no one else is working on it**

#### Development Setup

```bash
# Clone the repository
git clone https://github.com/FhenixProtocol/fhenix-confidential-contracts.git
cd fhenix-confidential-contracts

# Install dependencies
pnpm install

# Run tests
pnpm test
```

#### Code Style Requirements

**Solidity**
- Follow [Solidity Style Guide](https://docs.soliditylang.org/en/latest/style-guide.html)
- Use NatSpec comments for all public functions
- Maximum line length: 120 characters
- Run `pnpm format` before committing

**TypeScript**
- Follow ESLint configuration
- Run `pnpm lint` before committing

#### Testing Requirements

All code changes must include appropriate tests:

```bash
# Run full test suite
pnpm test

# Run with gas reporting
pnpm gas
```

- Aim for high test coverage
- Test both success and failure cases
- Include edge cases

#### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

Examples:
```
feat(FHERC20): add batch transfer functionality
fix(FHERC20Permit): correct nonce validation logic
docs(README): update installation instructions
```

#### Pull Request Guidelines

1. **Create a feature branch** from `master`
2. **Keep changes focused** - one feature/fix per PR
3. **Update documentation** as needed
4. **Update CHANGELOG.md** for user-facing changes
5. **Ensure CI passes** before requesting review

PR Title Format:
```
<type>(<scope>): <description>
```

#### Review Process

1. At least one maintainer approval required
2. All CI checks must pass
3. Changes may be requested - please respond promptly
4. Once approved, maintainers will merge

## Versioning

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR**: Incompatible API changes
- **MINOR**: New features (backwards compatible)
- **PATCH**: Bug fixes (backwards compatible)

### Pre-release Versions

- `X.Y.Z-alpha.N`: Early development
- `X.Y.Z-beta.N`: Feature complete, testing
- `X.Y.Z-rc.N`: Release candidate

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

Feel free to open a discussion or reach out to the maintainers.
