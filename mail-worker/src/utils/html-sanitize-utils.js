import { parseHTML } from "linkedom";

const ALLOWED_TAGS = new Set([
	"A", "B", "BLOCKQUOTE", "BODY", "BR", "DIV", "EM", "I", "IMG", "LI", "OL", "P", "SPAN",
	"STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "U", "UL"
]);

const ALLOWED_ATTRS = new Set(["alt", "height", "href", "rel", "src", "style", "target", "title", "width"]);
const ALLOWED_PROTOCOLS = ["http:", "https:", "mailto:", "tel:"];
const ALLOWED_IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function isSafeUrl(value) {
	try {
		const url = new URL(value, "https://example.com");
		return ALLOWED_PROTOCOLS.includes(url.protocol);
	} catch (_) {
		return false;
	}
}

function isSafeImageUrl(value) {
	if (ALLOWED_IMAGE_DATA_URL.test(value)) {
		return true;
	}

	try {
		const url = new URL(value, "https://example.com");
		return url.protocol === "http:" || url.protocol === "https:";
	} catch (_) {
		return false;
	}
}

function sanitizeStyle(value) {
	return value
		.split(";")
		.map(item => item.trim())
		.filter(item => item && !/expression|javascript:|url\s*\(/i.test(item))
		.join("; ");
}

function sanitizeNode(node) {
	if (node.nodeType === 1) {
		if (node.tagName === "SCRIPT" || node.tagName === "STYLE") {
			node.remove();
			return;
		}

		if (!ALLOWED_TAGS.has(node.tagName)) {
			node.replaceWith(...Array.from(node.childNodes));
			return;
		}

		for (const attr of Array.from(node.attributes)) {
			const name = attr.name.toLowerCase();
			const value = attr.value || "";

			if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) {
				node.removeAttribute(attr.name);
				continue;
			}

			if (name === "href" && !isSafeUrl(value)) {
				node.removeAttribute(attr.name);
				continue;
			}

			if (name === "src" && (node.tagName !== "IMG" || !isSafeImageUrl(value))) {
				node.removeAttribute(attr.name);
				continue;
			}

			if (["height", "width"].includes(name) && !/^\d{1,4}$/.test(value)) {
				node.removeAttribute(attr.name);
				continue;
			}

			if (name === "style") {
				const cleanStyle = sanitizeStyle(value);
				if (cleanStyle) {
					node.setAttribute("style", cleanStyle);
				} else {
					node.removeAttribute(attr.name);
				}
			}
		}

		if (node.tagName === "A") {
			node.setAttribute("rel", "noopener noreferrer");
		}
	}

	for (const child of Array.from(node.childNodes)) {
		sanitizeNode(child);
	}
}

export function sanitizeRichText(html) {
	if (!html || !html.trim()) {
		return null;
	}

	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	sanitizeNode(document.body);
	const cleaned = document.body.innerHTML.trim();
	return cleaned || null;
}
