# fast-cf-pages-upload-action

Uploads a directory of static assets to Cloudflare Pages by using the Cloudflare API directly.

It's much faster than installing `wrangler`, which is what the official action does.

## Usage

1. Create a CF API token with the "Cloudflare Pages — Edit" permission and add it as a secret
1. Example workflow which deploys the `build` directory whenever a release is published or a PR to `main` is updated:

   ```yml
   on:
    release:
      types: [released]
    pull_request:
      branches: [main]

   jobs:
     publish:
       runs-on: ubuntu-latest
       permissions:
         contents: read
         deployments: write
         pull-requests: write # This allows the action to add a comment to the PR with the deployment URL
       name: Deploy to CF Pages
       steps:
         - name: Checkout
           uses: actions/checkout@v3

         # Build step(s) go here

         - name: Deploy to CF Pages
           uses: grimsteel/fast-cf-pages-upload-action@v1
           with:
             apiToken: ${{ secrets.CF_TOKEN }}
             accountId: ACCOUNT_ID
             projectName: PAGES_PROJECT_NAME
             directory: build
             githubToken: ${{ secrets.GITHUB_TOKEN }}
   ```

1. Replace `ACCOUNT_ID` and `PAGES_PROJECT_NAME` with the appropriate values

## Outputs

| Name           | Description                                         |
| -------------- | --------------------------------------------------- |
| `deploymentId` | The ID of the pages deployment                      |
| `deploymentUrl`| The URL of the pages deployment                     |
| `environment`  | The environment that was deployed to                |