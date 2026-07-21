# Deploying a Fling Project via GitHub Actions

## Prerequisites

- A Fling project with a GitHub repository
- The `gh` CLI installed and authenticated
- A Fling account (logged in locally via `fling login`)

## Setup

### 1. Add your Fling token as a GitHub secret

```bash
gh secret set FLING_TOKEN < ~/.config/fling/token
```

### 2. Create the workflow file

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - name: Set up Fling
        run: |
          mkdir -p ~/.config/fling
          echo "${{ secrets.FLING_TOKEN }}" > ~/.config/fling/token
          mkdir -p .fling

      - run: npx fling -- --cli push
```

### 3. Commit and push

```bash
git add .github/workflows/deploy.yml
git commit -m "Add GitHub Action to deploy"
git push
```

The project will now deploy automatically on every push to `main`.

## Notes

- **Node 22+ is required** by the Fling CLI.
- **The `.fling/` directory is gitignored**, so the workflow creates it with `mkdir -p .fling` so the CLI recognizes the project.
- **The `--cli` flag** prevents the Fling CLI from launching interactive mode in CI.
- **Token rotation**: if you regenerate your Fling token, re-run the `gh secret set` command to update it.
