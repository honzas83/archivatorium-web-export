const TAG_CHARACTER = /[\p{L}\p{N}_\/-]/u;
const TAG_BODY = /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u;
const NON_NUMERIC = /[^\p{N}\/]/u;

export function isObsidianTag(tag) {
	const value = String(tag).replace(/^#/, "");
	return TAG_BODY.test(value) && NON_NUMERIC.test(value);
}

function maskedMarkdown(markdown) {
	const source = String(markdown);
	let output = "";
	let index = 0;
	let lineStart = true;
	let frontmatter = source.startsWith("---\n") || source.startsWith("---\r\n") ? "opening" : "";
	let fence = "";
	let inlineTicks = 0;
	let htmlComment = false;
	let htmlTag = false;

	while (index < source.length) {
		const character = source[index];
		const lineEnd = character === "\n";
		if (lineStart) {
			const rest = source.slice(index);
			const marker = rest.match(/^([ \t]*)(`{3,}|~{3,})/);
			if (frontmatter && /^---\s*(?:\r?\n|$)/.test(rest)) {
				const end = rest.match(/^---\s*\r?\n/)?.[0].length ?? 3;
				output += " ".repeat(end);
				index += end;
				lineStart = true;
				frontmatter = frontmatter === "opening" ? "content" : "";
				continue;
			}
			if (!frontmatter && marker) {
				const token = marker[2];
				if (!fence || token[0] === fence[0] && token.length >= fence.length) fence = fence ? "" : token;
				const lineLength = rest.indexOf("\n") >= 0 ? rest.indexOf("\n") + 1 : rest.length;
				output += " ".repeat(lineLength - (rest[lineLength - 1] === "\n" ? 1 : 0));
				if (rest[lineLength - 1] === "\n") output += "\n";
				index += lineLength;
				lineStart = true;
				continue;
			}
		}

		if (!frontmatter && !fence && !inlineTicks && source.startsWith("<!--", index)) htmlComment = true;
		if (!frontmatter && !fence && !inlineTicks && !htmlComment && character === "<") htmlTag = true;
		if (!fence && !htmlComment && character === "`") {
			let count = 1;
			while (source[index + count] === "`") count++;
			inlineTicks = inlineTicks === count ? 0 : inlineTicks || count;
			output += " ".repeat(count);
			index += count;
			lineStart = false;
			continue;
		}

		const hidden = Boolean(frontmatter) || Boolean(fence) || Boolean(inlineTicks) || htmlComment || htmlTag;
		output += hidden && !lineEnd ? " " : character;
		if (htmlComment && source.startsWith("-->", index)) {
			output = `${output.slice(0, -1)}   `;
			index += 3;
			htmlComment = false;
			lineStart = false;
			continue;
		}
		if (htmlTag && character === ">") htmlTag = false;
		index++;
		lineStart = lineEnd;
	}
	return output.replace(/\]\((?:\\.|[^)\n])*\)/g, (target) => " ".repeat(target.length));
}

export function findObsidianTags(markdown) {
	const source = maskedMarkdown(markdown);
	const matches = [];
	for (let index = 0; index < source.length; index++) {
		if (source[index] !== "#" || source[index - 1] === "\\") continue;
		const previous = source[index - 1];
		if (previous && TAG_CHARACTER.test(previous)) continue;
		let end = index + 1;
		while (end < source.length && TAG_CHARACTER.test(source[end])) end++;
		const tag = source.slice(index + 1, end);
		if (!isObsidianTag(tag)) continue;
		matches.push({ tag: `#${tag}`, value: tag, index, end });
		index = end - 1;
	}
	return matches;
}

export function normalizeFrontmatterTags(values) {
	return values
		.map((value) => String(value).trim().replace(/^#/, ""))
		.filter(isObsidianTag)
		.map((value) => `#${value}`);
}
