import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

export default defineConfig({
	site: "https://nilenso.github.io",
	base: "/megasthenes",
	integrations: [
		starlight({
			title: "megasthenes",
			customCss: ["./src/styles/custom.css"],
			social: [
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/nilenso/megasthenes",
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
