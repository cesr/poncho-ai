import { spawn } from "node:child_process";
import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, normalize, relative, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const runPnpmInstall = async (workingDir: string): Promise<void> =>
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn("pnpm", ["install"], {
      cwd: workingDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveInstall();
        return;
      }
      rejectInstall(new Error(`pnpm install failed with exit code ${code ?? -1}`));
    });
  });

export const runInstallCommand = async (
  workingDir: string,
  packageNameOrPath: string,
): Promise<void> =>
  await new Promise<void>((resolveInstall, rejectInstall) => {
    const child = spawn("pnpm", ["add", packageNameOrPath], {
      cwd: workingDir,
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      if (code === 0) {
        resolveInstall();
        return;
      }
      rejectInstall(new Error(`pnpm add failed with exit code ${code ?? -1}`));
    });
  });

/**
 * Resolve the installed npm package name from a package specifier.
 * Handles local paths, scoped packages, and GitHub shorthand (e.g.
 * "vercel-labs/agent-skills" installs as "agent-skills").
 */
export const resolveInstalledPackageName = (packageNameOrPath: string): string | null => {
  if (packageNameOrPath.startsWith(".") || packageNameOrPath.startsWith("/")) {
    return null; // local path — handled separately
  }
  // Scoped package: @scope/name
  if (packageNameOrPath.startsWith("@")) {
    return packageNameOrPath;
  }
  // GitHub shorthand: owner/repo — npm installs as the repo name
  if (packageNameOrPath.includes("/")) {
    return packageNameOrPath.split("/").pop() ?? packageNameOrPath;
  }
  return packageNameOrPath;
};

/**
 * Locate the root directory of an installed skill package.
 * Handles local paths, normal npm packages, and GitHub repos (which may
 * lack a root package.json).
 */
export const resolveSkillRoot = (
  workingDir: string,
  packageNameOrPath: string,
): string => {
  // Local path
  if (packageNameOrPath.startsWith(".") || packageNameOrPath.startsWith("/")) {
    return resolve(workingDir, packageNameOrPath);
  }

  const moduleName =
    resolveInstalledPackageName(packageNameOrPath) ?? packageNameOrPath;

  // Try require.resolve first (works for packages with a package.json)
  try {
    const packageJsonPath = require.resolve(`${moduleName}/package.json`, {
      paths: [workingDir],
    });
    return resolve(packageJsonPath, "..");
  } catch {
    // Fall back to looking in node_modules directly (GitHub repos may lack
    // a root package.json)
    const candidate = resolve(workingDir, "node_modules", moduleName);
    if (existsSync(candidate)) {
      return candidate;
    }
    throw new Error(
      `Could not locate installed package "${moduleName}" in ${workingDir}`,
    );
  }
};

export const normalizeSkillSourceName = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^@/, "")
    .replace(/[\/\s]+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "skills";
};

export const collectSkillManifests = async (dir: string, depth = 2): Promise<string[]> => {
  const manifests: string[] = [];
  const localManifest = resolve(dir, "SKILL.md");
  try {
    await access(localManifest);
    manifests.push(localManifest);
  } catch {
    // Not found at this level — look one level deeper (e.g. skills/<name>/SKILL.md)
  }

  if (depth <= 0) return manifests;

  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      let isDir = entry.isDirectory();
      // Dirent reports symlinks separately; resolve target type via stat()
      if (!isDir && entry.isSymbolicLink()) {
        try {
          const s = await stat(resolve(dir, entry.name));
          isDir = s.isDirectory();
        } catch {
          continue; // broken symlink — skip
        }
      }

      if (isDir) {
        manifests.push(...(await collectSkillManifests(resolve(dir, entry.name), depth - 1)));
      }
    }
  } catch {
    // ignore read errors
  }

  return manifests;
};

export const validateSkillPackage = async (
  workingDir: string,
  packageNameOrPath: string,
): Promise<{ skillRoot: string; manifests: string[] }> => {
  const skillRoot = resolveSkillRoot(workingDir, packageNameOrPath);
  const manifests = await collectSkillManifests(skillRoot);
  if (manifests.length === 0) {
    throw new Error(`Skill validation failed: no SKILL.md found in ${skillRoot}`);
  }
  return { skillRoot, manifests };
};

export const selectSkillManifests = async (
  skillRoot: string,
  manifests: string[],
  relativeSkillPath?: string,
): Promise<string[]> => {
  if (!relativeSkillPath) return manifests;

  const normalized = normalize(relativeSkillPath);
  if (normalized.startsWith("..") || normalized.startsWith("/")) {
    throw new Error(`Invalid skill path "${relativeSkillPath}": path must be within package root.`);
  }

  const candidate = resolve(skillRoot, normalized);
  const relativeToRoot = relative(skillRoot, candidate).split("\\").join("/");
  if (relativeToRoot.startsWith("..") || relativeToRoot.startsWith("/")) {
    throw new Error(`Invalid skill path "${relativeSkillPath}": path escapes package root.`);
  }

  const candidateAsFile = candidate.toLowerCase().endsWith("skill.md")
    ? candidate
    : resolve(candidate, "SKILL.md");
  if (!existsSync(candidateAsFile)) {
    throw new Error(
      `Skill path "${relativeSkillPath}" does not point to a directory (or file) containing SKILL.md.`,
    );
  }

  const selected = manifests.filter((manifest) => resolve(manifest) === resolve(candidateAsFile));
  if (selected.length === 0) {
    throw new Error(`Skill path "${relativeSkillPath}" was not discovered as a valid skill manifest.`);
  }
  return selected;
};

export const copySkillsIntoProject = async (
  workingDir: string,
  manifests: string[],
  sourceName: string,
): Promise<string[]> => {
  const skillsDir = resolve(workingDir, "skills", normalizeSkillSourceName(sourceName));
  await mkdir(skillsDir, { recursive: true });

  const destinations = new Map<string, string>();
  for (const manifest of manifests) {
    const sourceSkillDir = dirname(manifest);
    const skillFolderName = basename(sourceSkillDir);
    if (destinations.has(skillFolderName)) {
      throw new Error(
        `Skill copy failed: multiple skill directories map to "skills/${skillFolderName}" (${destinations.get(skillFolderName)} and ${sourceSkillDir}).`,
      );
    }
    destinations.set(skillFolderName, sourceSkillDir);
  }

  const copied: string[] = [];
  for (const [skillFolderName, sourceSkillDir] of destinations.entries()) {
    const destinationSkillDir = resolve(skillsDir, skillFolderName);
    if (existsSync(destinationSkillDir)) {
      throw new Error(
        `Skill copy failed: destination already exists at ${destinationSkillDir}. Remove or rename it and try again.`,
      );
    }
    await cp(sourceSkillDir, destinationSkillDir, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: true,
    });
    copied.push(relative(workingDir, destinationSkillDir).split("\\").join("/"));
  }

  return copied.sort();
};

export const copySkillsFromPackage = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<string[]> => {
  const { skillRoot, manifests } = await validateSkillPackage(workingDir, packageNameOrPath);
  const selected = await selectSkillManifests(skillRoot, manifests, options?.path);
  const sourceName = resolveInstalledPackageName(packageNameOrPath) ?? basename(skillRoot);
  return await copySkillsIntoProject(workingDir, selected, sourceName);
};

export const addSkill = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<void> => {
  await runInstallCommand(workingDir, packageNameOrPath);
  const copiedSkills = await copySkillsFromPackage(workingDir, packageNameOrPath, options);
  process.stdout.write(
    `Added ${copiedSkills.length} skill${copiedSkills.length === 1 ? "" : "s"} from ${packageNameOrPath}:\n`,
  );
  for (const copied of copiedSkills) {
    process.stdout.write(`- ${copied}\n`);
  }
};

const getSkillFolderNames = (manifests: string[]): string[] => {
  const names = new Set<string>();
  for (const manifest of manifests) {
    names.add(basename(dirname(manifest)));
  }
  return Array.from(names).sort();
};

export const removeSkillsFromPackage = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<{ removed: string[]; missing: string[] }> => {
  const { skillRoot, manifests } = await validateSkillPackage(workingDir, packageNameOrPath);
  const selected = await selectSkillManifests(skillRoot, manifests, options?.path);
  const skillsDir = resolve(workingDir, "skills");
  const sourceName = normalizeSkillSourceName(
    resolveInstalledPackageName(packageNameOrPath) ?? basename(skillRoot),
  );
  const sourceSkillsDir = resolve(skillsDir, sourceName);
  const skillNames = getSkillFolderNames(selected);

  const removed: string[] = [];
  const missing: string[] = [];

  if (!options?.path && existsSync(sourceSkillsDir)) {
    await rm(sourceSkillsDir, { recursive: true, force: false });
    removed.push(`skills/${sourceName}`);
    return { removed, missing };
  }

  for (const skillName of skillNames) {
    const destinationSkillDir = resolve(sourceSkillsDir, skillName);
    const normalized = relative(skillsDir, destinationSkillDir).split("\\").join("/");
    if (normalized.startsWith("..") || normalized.startsWith("/")) {
      throw new Error(`Refusing to remove path outside skills directory: ${destinationSkillDir}`);
    }

    if (!existsSync(destinationSkillDir)) {
      missing.push(`skills/${sourceName}/${skillName}`);
      continue;
    }

    await rm(destinationSkillDir, { recursive: true, force: false });
    removed.push(`skills/${sourceName}/${skillName}`);
  }

  return { removed, missing };
};

export const removeSkillPackage = async (
  workingDir: string,
  packageNameOrPath: string,
  options?: { path?: string },
): Promise<void> => {
  const result = await removeSkillsFromPackage(workingDir, packageNameOrPath, options);
  process.stdout.write(
    `Removed ${result.removed.length} skill${result.removed.length === 1 ? "" : "s"} from ${packageNameOrPath}:\n`,
  );
  for (const removed of result.removed) {
    process.stdout.write(`- ${removed}\n`);
  }
  if (result.missing.length > 0) {
    process.stdout.write(
      `Skipped ${result.missing.length} missing skill${result.missing.length === 1 ? "" : "s"}:\n`,
    );
    for (const missing of result.missing) {
      process.stdout.write(`- ${missing}\n`);
    }
  }
};

export const listInstalledSkills = async (
  workingDir: string,
  sourceName?: string,
): Promise<string[]> => {
  const skillsRoot = resolve(workingDir, "skills");
  const resolvedSourceName = sourceName
    ? resolveInstalledPackageName(sourceName) ?? sourceName
    : undefined;
  const targetRoot = sourceName
    ? resolve(skillsRoot, normalizeSkillSourceName(resolvedSourceName ?? sourceName))
    : skillsRoot;
  if (!existsSync(targetRoot)) {
    return [];
  }
  const manifests = await collectSkillManifests(targetRoot, sourceName ? 1 : 2);
  return manifests
    .map((manifest) => relative(workingDir, dirname(manifest)).split("\\").join("/"))
    .sort();
};

export const listSkills = async (workingDir: string, sourceName?: string): Promise<void> => {
  const skills = await listInstalledSkills(workingDir, sourceName);
  if (skills.length === 0) {
    process.stdout.write("No installed skills found.\n");
    return;
  }
  const resolvedSourceName = sourceName
    ? resolveInstalledPackageName(sourceName) ?? sourceName
    : undefined;
  process.stdout.write(
    sourceName
      ? `Installed skills for ${normalizeSkillSourceName(resolvedSourceName ?? sourceName)}:\n`
      : "Installed skills:\n",
  );
  for (const skill of skills) {
    process.stdout.write(`- ${skill}\n`);
  }
};
