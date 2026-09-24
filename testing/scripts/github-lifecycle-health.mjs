import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIRMATION = "GALAXY_GITHUB_LIFECYCLE_CONFIRM";
const DESCRIPTION = "Temporary Galaxy Code Git lifecycle health check";
const HEALTH_REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(galaxy-code-health-[0-9]+-[a-f0-9]{8})$/;

function execute(file, args, cwd, allowFailure = false) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const result = Object.freeze({
        exitCode: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stderr: stderr.trim(),
        stdout: stdout.trim(),
      });
      if (error && !allowFailure) {
        reject(new Error(`${file} ${args.slice(0, 3).join(" ")} failed: ${result.stderr || error.message}`));
      } else {
        resolve(result);
      }
    });
  });
}

if (process.env[CONFIRMATION] !== "1") {
  throw new Error(`Refusing external GitHub mutation. Set ${CONFIRMATION}=1 for this explicit, temporary private-repository health check.`);
}

await execute("gh", ["auth", "status"], process.cwd());
const identity = await execute("gh", ["api", "user", "--jq", ".login"], process.cwd());
const owner = identity.stdout;
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
  throw new Error("GitHub CLI returned an invalid authenticated login.");
}

const scopeProbe = await execute("gh", ["api", "--include", "user"], process.cwd());
const oauthScopes = /^x-oauth-scopes:\s*(.*)$/im.exec(`${scopeProbe.stdout}\n${scopeProbe.stderr}`)?.[1]
  ?.split(",")
  .map((scope) => scope.trim())
  .filter(Boolean) ?? [];
if (!oauthScopes.includes("delete_repo")) {
  throw new Error(
    "GitHub lifecycle preflight failed before repository creation: the active credential lacks the delete_repo scope. " +
    "Run 'gh auth refresh -h github.com -s delete_repo', then retry. No new repository was created.",
  );
}

const cleanupIndex = process.argv.indexOf("--cleanup-existing");
if (cleanupIndex !== -1) {
  const repository = process.argv[cleanupIndex + 1] ?? "";
  if (process.argv.length !== 4 || cleanupIndex !== 2) {
    throw new Error("Cleanup usage: npm run test:github-lifecycle -- --cleanup-existing <owner/galaxy-code-health-id>.");
  }
  const match = HEALTH_REPOSITORY.exec(repository);
  if (match === null || match[1] !== owner) {
    throw new Error(`Refusing cleanup outside the authenticated owner's Galaxy health repositories: ${repository || "<missing>"}.`);
  }
  const view = await execute("gh", [
    "repo", "view", repository,
    "--json", "nameWithOwner,visibility,description",
  ], process.cwd());
  const metadata = JSON.parse(view.stdout);
  if (metadata.nameWithOwner !== repository || metadata.visibility !== "PRIVATE" || metadata.description !== DESCRIPTION) {
    throw new Error(`Refusing cleanup because ${repository} does not match the private Galaxy lifecycle marker.`);
  }
  await execute("gh", ["repo", "delete", repository, "--yes"], process.cwd());
  const verification = await execute("gh", ["repo", "view", repository, "--json", "name"], process.cwd(), true);
  if (verification.exitCode === 0) throw new Error(`Cleanup verification failed: ${repository} still exists.`);
  process.stdout.write(`${JSON.stringify({ cleanedExistingRepository: true, passed: true, repository })}\n`);
  process.exit(0);
}

const repositoryName = `galaxy-code-health-${Date.now()}-${randomBytes(4).toString("hex")}`;
const repository = `${owner}/${repositoryName}`;
const existing = await execute("gh", ["repo", "view", repository, "--json", "name"], process.cwd(), true);
if (existing.exitCode === 0) throw new Error(`Refusing to use existing repository ${repository}.`);

const root = await mkdtemp(join(tmpdir(), "galaxy-code-github-health-"));
const producer = join(root, repositoryName);
const consumer = join(root, "consumer");
let created = false;
let failure;
try {
  await execute("gh", [
    "repo", "create", repository,
    "--private", "--clone",
    "--description", DESCRIPTION,
    "--disable-issues", "--disable-wiki",
  ], root);
  created = true;
  await execute("git", ["config", "user.name", "GalaxyLifecycle"], producer);
  await execute("git", ["config", "user.email", "lifecycle@local.invalid"], producer);
  await writeFile(join(producer, "version.txt"), "v1\n", "utf8");
  await execute("git", ["add", "version.txt"], producer);
  await execute("git", ["commit", "--quiet", "-m", "initial health state"], producer);
  await execute("git", ["push", "--quiet", "origin", "HEAD"], producer);
  await execute("gh", ["repo", "clone", repository, consumer], root);
  await writeFile(join(producer, "version.txt"), "v2\n", "utf8");
  await execute("git", ["add", "version.txt"], producer);
  await execute("git", ["commit", "--quiet", "-m", "update health state"], producer);
  await execute("git", ["push", "--quiet", "origin", "HEAD"], producer);
  await execute("git", ["pull", "--quiet", "--ff-only"], consumer);
  if (await readFile(join(consumer, "version.txt"), "utf8") !== "v2\n") {
    throw new Error("GitHub clone did not receive the pushed v2 content.");
  }
} catch (error) {
  failure = error;
} finally {
  let cleanupFailure;
  if (created) {
    try {
      await execute("gh", ["repo", "delete", repository, "--yes"], root);
    } catch (error) {
      cleanupFailure = error;
    }
  }
  await rm(root, { recursive: true, force: true });
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], `GitHub lifecycle failed and ${repository} could not be deleted.`);
  if (cleanupFailure) throw cleanupFailure;
  if (failure) throw failure;
}

process.stdout.write(`${JSON.stringify({ createdPrivateRepository: true, deletedRepository: true, passed: true, repository })}\n`);
