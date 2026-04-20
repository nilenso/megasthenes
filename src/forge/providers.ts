import { MegasthenesError } from "../errors";

/** Supported git forge types */
export type ForgeName = "github" | "gitlab";

/** Interface for git forge implementations */
export interface Forge {
	/** The forge identifier */
	name: ForgeName;
	/** Build an authenticated clone URL */
	buildCloneUrl(repoUrl: string, token?: string): string;
}

export const GitHubForge: Forge = {
	name: "github",
	buildCloneUrl(repoUrl: string, token?: string): string {
		if (!token) return repoUrl;
		const url = new URL(repoUrl);
		url.username = token;
		return url.toString();
	},
};

export const GitLabForge: Forge = {
	name: "gitlab",
	buildCloneUrl(repoUrl: string, token?: string): string {
		if (!token) return repoUrl;
		const url = new URL(repoUrl);
		url.username = "oauth2";
		url.password = token;
		return url.toString();
	},
};

export const forges: Record<ForgeName, Forge> = {
	github: GitHubForge,
	gitlab: GitLabForge,
};

export function inferForge(repoUrl: string): ForgeName | null {
	const url = new URL(repoUrl);
	if (url.hostname === "github.com") return "github";
	if (url.hostname === "gitlab.com") return "gitlab";
	return null;
}

export function parseRepoPath(repoUrl: string): { username: string; reponame: string } {
	const url = new URL(repoUrl);
	const parts = url.pathname
		.replace(/^\//, "")
		.replace(/\.git$/, "")
		.split("/");
	if (parts.length < 2 || !parts[0] || !parts[1]) {
		throw new MegasthenesError("invalid_config", `Invalid repo URL: ${repoUrl}`, { retryability: "no" });
	}
	return { username: parts[0], reponame: parts[1] };
}
