import { addClassName } from "@expressive-code/core";

const SHELL_LANGUAGES = new Set(["bash", "sh", "shell", "shellsession", "zsh"]);

export function shellCommentMarker() {
	return {
		name: "shell-comment-marker",
		hooks: {
			postprocessRenderedLine: ({ codeBlock, line, renderData }) => {
				if (!SHELL_LANGUAGES.has(codeBlock.language)) return;
				if (!line.text.trimStart().startsWith("#")) return;
				addClassName(renderData.lineAst, "is-shell-comment");
			},
		},
	};
}
