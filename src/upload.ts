import { join, relative, resolve, sep, extname } from "path";
import { sep as posixSep } from "path/posix";
import { readdir, stat, readFile } from "fs/promises";
import { blake3 } from "@noble/hashes/blake3";
import type { Deployment, DirectUploadsJWT, Project, UploadFileGroupPayload } from "@cloudflare/types";
import { lookup as mimeLookup } from "mime-types";

declare global {
  const FCFP_VERSION: string;
}

interface UploadableFile {
  absolutePath: string; // something like "/home/runner/work/site/dist/images/logo.png"
  size: number; // bytes
  mime: string;
  hash: string; // blake3 hash of base64 contents + extension
  publicUrl: string; // something like "/images/logo.png"
}

const userAgent = `fast-pages-upload/${FCFP_VERSION}`;
const ignoredFiles = new Set([
  "_worker.js",
  "_redirects",
  "_headers",
  "_routes.json"
]);
const cfBaseUrl = "https://api.cloudflare.com/client/v4";

async function findUploadableFiles(dir: string): Promise<UploadableFile[]> {
  const resolvedDir = resolve(dir);

  // List all the files within the directory that are not part of the exclude list
  const dirEntries = await readdir(resolvedDir, { recursive: true, withFileTypes: true });
  const files = dirEntries.filter(entry => entry.isFile()).filter(entry => !ignoredFiles.has(entry.name));

  return await Promise.all(files.map(async file => {
    const absolutePath = resolve(resolvedDir, file.path, file.name);
    // The public URL is the relative path from the upload directory to the file, with forward slashes
    const publicUrl = "/" + relative(resolvedDir, absolutePath).split(sep).join(posixSep);
    const { size } = await stat(absolutePath);

    /// blake3 hash of base64 contents + extension
    const hashData = (await readFile(absolutePath)).toString("base64") + extname(absolutePath).slice(1);
    const hash = Buffer.from(blake3(hashData, { dkLen: 16 })).toString("hex"); // we need the first 32 hex chars of the hash -> 16 bytes
    
    return {
      absolutePath,
      size,
      mime: mimeLookup(absolutePath) || "application/octet-stream",
      hash,
      publicUrl
    };
  }));
}

async function cfApiRequest<Result>(method: string, url: string, token: string, body?: any) {
  const response = await fetch(cfBaseUrl + url, {
    method,
    headers: {
      "User-Agent": userAgent,
      "Authorization": `Bearer ${token}`
    },
    body: body instanceof FormData ? body : JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`Cloudflare API request failed with status ${response.status}: ${await response.text()}`);
  }

  const json = await response.json() as { result: Result };

  return json.result;
}

export async function getProject(cfToken: string, accountId: string, projectName: string) {
  const project = await cfApiRequest<Project>("GET", `/accounts/${accountId}/pages/projects/${projectName}`, cfToken);

  return project;
}

export async function upload(cfToken: string, directory: string, accountId: string, projectName: string, gitData: { branch: string, commit: string, commitMessage: string }): Promise<Deployment> {
  // List the files in the directory
  const files = await findUploadableFiles(directory);

  const { jwt: uploadsJwt } = await cfApiRequest<DirectUploadsJWT>("GET", `/accounts/${accountId}/pages/projects/${projectName}/upload-token`, cfToken);

  const missingHashes = await cfApiRequest<string[]>("POST", `/pages/assets/check-missing`, uploadsJwt, { hashes: files.map(file => file.hash) });

  // Filter out files that are already uploaded and sort the remaining files by size descending
  const filesToUpload = files.filter(file => missingHashes.includes(file.hash)).sort((a, b) => b.size - a.size);

  // Organize the files into buckets. Start with 3 buckets. Each has a max of 50 MB and 5000 files
  const uploadBuckets = filesToUpload.reduce((buckets, file, i) => {
    // Start checking from a new bucket each time
    let bucket = buckets[(Array(buckets.length).fill(0).map((_, j) => j).find((_, j) => {
      const bucket = buckets[(i + j) % buckets.length];
      return (bucket.size + file.size) <= 50 * 1024 * 1024 && bucket.files.length <= 5000;
    }) + i) % buckets.length];

    if (!bucket) {
      bucket = { size: 0, files: [] };
      buckets.push(bucket);
    }

    bucket.files.push(file);
    bucket.size += file.size;

    return buckets;
  }, Array(3).fill(null).map(() => ({ files: [] as UploadableFile[], size: 0 })));

  await Promise.all(uploadBuckets.filter(el => el.files.length > 0).map(async bucket => {
    // Prepare the upload payload
    const payload: UploadFileGroupPayload[] = await Promise.all(bucket.files.map(async file => ({
      key: file.hash,
      value: (await readFile(file.absolutePath)).toString("base64"),
      metadata: {
        contentType: file.mime
      },
      base64: true
    })));

    // Upload the files
    await cfApiRequest("POST", `/pages/assets/upload`, uploadsJwt, payload);
  }));

  // Update the hashes
  await cfApiRequest("POST", `/pages/assets/upsert-hashes`, uploadsJwt, { hashes: files.map(file => file.hash) });

  // Setup the deployment
  const formData = new FormData();
  formData.append("manifest", JSON.stringify(Object.fromEntries(files.map(file => [file.publicUrl, file.hash]))));
  formData.append("branch", gitData.branch);
  formData.append("commit_hash", gitData.commit);
  formData.append("commit_message", gitData.commitMessage);
  formData.append("commit_dirty", "false");

  try {
    const redirectsFile = await readFile(join(directory, "_redirects"), "utf8");
    formData.append("_redirects", new File([redirectsFile], "_redirects"));
  } catch {  }

  try {
    const headersFile = await readFile(join(directory, "_headers"), "utf8");
    formData.append("_headers", new File([headersFile], "_headers"));
  } catch {  }

  // Create the deployment
  const deploymentResponse = await cfApiRequest<Deployment>("POST", `/accounts/${accountId}/pages/projects/${projectName}/deployments`, cfToken, formData);

  return deploymentResponse;
}