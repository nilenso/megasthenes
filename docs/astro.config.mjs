import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

export default defineConfig({
	site: "https://nilenso.github.io",
	base: "/ask-forge",
	integrations: [
		starlight({
			title: "ask-forge",
			customCss: ["./src/styles/custom.css"],
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/nilenso/ask-forge",
				},
			],
			plugins: [
				starlightTypeDoc({
					entryPoints: ["../src/index.ts"],
					tsconfig: "./tsconfig.json",
					output: "api",
					sidebar: {
						label: "API Reference",
						collapsed: false,
					},
					typeDoc: {
						excludePrivate: true,
						excludeInternal: true,
					},
				}),
			],
			sidebar: [
				{
					label: "Start Here",
					autogenerate: { directory: "start-here" },
				},
				{
					label: "Guides",
					autogenerate: { directory: "guides" },
				},
				{
					label: "Contributing",
					autogenerate: { directory: "contributing" },
				},
				typeDocSidebarGroup,
			],
		}),
	],
});
