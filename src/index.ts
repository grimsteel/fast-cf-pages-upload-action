import { getOctokit, context } from "@actions/github";
import { getInput, setFailed, setOutput, summary } from "@actions/core";
import { PullRequestEvent, PushEvent, ReleaseEvent } from "@octokit/webhooks-types"
import { Context } from "@actions/github/lib/context.js";
import { getProject, upload } from "./upload.js";

type TypedContext<T> = Context & { payload: T };

interface GithubEventMap {
  pull_request: PullRequestEvent;
  push: PushEvent;
  release: ReleaseEvent;
}

function isEventType<T extends keyof GithubEventMap>(context: Context, type: T): context is TypedContext<GithubEventMap[T]> {
  return context.eventName === type;
}

async function run() {
  try {
    const githubToken = getInput("githubToken", { required: true });
    const cfToken = getInput("apiToken", { required: true });
    const accountId = getInput("accountId", { required: true });
    const projectName = getInput("projectName", { required: true });
    const directory = getInput("directory", { required: true });
    
    const ref =
      isEventType(context, "pull_request") ? context.payload.pull_request.head.ref :
      isEventType(context, "release") ? context.payload.release.target_commitish : context.ref;
    const sha = isEventType(context, "pull_request") ? context.payload.pull_request.head.sha : context.sha;
    const commitMessage = 
      isEventType(context, "pull_request") ? context.payload.pull_request.title :
      isEventType(context, "push") ? context.payload.head_commit.message :
      isEventType(context, "release") ? context.payload.release.name :"";
    const gitData = {
      branch: ref,
      commit: sha,
      commitMessage
    };

    const octokit = getOctokit(githubToken);

    // Start by looking for this pages project
    const project = await getProject(cfToken, accountId, projectName);
    const isProduction = project.production_branch === ref;

    const environmentString = isProduction ? `${projectName} (Production)` : `${projectName} (Preview - ${ref})`;

    // Create the github deployment
    const githubDeployment = await octokit.rest.repos.createDeployment({
      ...context.repo,
      ref,
      auto_merge: false,
      description: "Cloudflare Pages",
      environment: environmentString,
      required_contexts: [],
      production_environment: isProduction,
      transient_environment: !isProduction,
    });

    if (githubDeployment.status !== 201) throw new Error(`Failed to create Github deployment: ${githubDeployment.status}`);

    // Deploy to CF Pages
    const cfDeployment = await upload(cfToken, directory, accountId, projectName, gitData);

    // Update the github deployment status
    await octokit.rest.repos.createDeploymentStatus({
      ...context.repo,
      deployment_id: githubDeployment.data.id,
      state: "success",
      environment_url: cfDeployment.url,
      log_url: `https://dash.cloudflare.com/${accountId}/pages/view/${projectName}/${cfDeployment.id}`,
      description: "Cloudflare Pages",
      auto_inactive: false,
      environment: environmentString,
    });

    setOutput("deploymentId", cfDeployment.id);
    setOutput("deploymentUrl", cfDeployment.url);
    setOutput("environment", environmentString);

    // The alias URL is the last domain in the list for production (usually the custom domain), or the branch subdomain for previews
    const aliasUrl = isProduction ? project.domains[project.domains.length - 1] : `https://${cfDeployment.deployment_trigger.metadata.branch}.${project.subdomain}`;

    summary.addHeading("Deployed to Cloudflare Pages");
    summary.addRaw(`<b>Environment</b>: ${environmentString}<br>`, true);

    summary.addRaw(`<b>Branch URL</b>: `);
    summary.addLink(aliasUrl, aliasUrl);
    summary.addRaw(`<br>`, true);

    summary.addRaw(`<b>Deployment ID</b>: ${cfDeployment.id}<br>`, true);

    summary.addRaw(`<b>Deployment URL</b>: `);
    summary.addLink(cfDeployment.url, cfDeployment.url);
    summary.addRaw(`<br>`, true);

    await summary.write();

    if (isEventType(context, "pull_request")) {
      // Add a PR comment
      const existingComments = await octokit.rest.issues.listComments({
        ...context.repo,
        issue_number: context.payload.pull_request.number
      });

      const existingLinkComment = existingComments.data.find(comment => comment.body?.includes(`Sign: ${Buffer.from(ref).toString("base64")}`) && comment.user.type === "Bot");
      if (!existingLinkComment) {
        await octokit.rest.issues.createComment({
          ...context.repo,
          issue_number: context.payload.pull_request.number,
          body: `Visit the preview URL for this PR:

[**${aliasUrl}**](${aliasUrl})

<sub>Sign: ${Buffer.from(ref).toString("base64")}</sub>`
        });
      }
    }
  } catch (error) {
    setFailed(error.message);
  }
}

run()
