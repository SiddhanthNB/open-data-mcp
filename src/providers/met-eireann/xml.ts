import { XMLParser } from "fast-xml-parser";

import { AppError } from "../../errors";

export interface ForecastElement {
  name: string;
  attributes: Readonly<Record<string, string>>;
  text?: string;
}

export interface ForecastBlock {
  kind: "instant" | "interval";
  sequence: number;
  attributes: Readonly<Record<string, string>>;
  location: {
    attributes: Readonly<Record<string, string>>;
    elements: readonly ForecastElement[];
  };
}

export interface ParsedForecast {
  metadata: {
    root_attributes: Readonly<Record<string, string>>;
    models: readonly Readonly<Record<string, string>>[];
  };
  productAttributes: Readonly<Record<string, string>>;
  blocks: readonly ForecastBlock[];
}

type OrderedNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

export function parseForecastXml(
  xml: string,
  fields?: readonly string[],
): ParsedForecast {
  if (
    xml.trim() === "" ||
    /<!DOCTYPE/i.test(xml) ||
    /<!ENTITY/i.test(xml)
  ) {
    throw new AppError("UPSTREAM_ERROR");
  }

  let document: unknown;
  try {
    document = parser.parse(xml);
  } catch {
    throw new AppError("UPSTREAM_ERROR");
  }
  if (!Array.isArray(document)) {
    throw new AppError("UPSTREAM_ERROR");
  }

  const root = singleElement(document, "weatherdata");
  const rootChildren = elementChildren(root, "weatherdata");
  const meta = singleElement(rootChildren, "meta");
  const product = singleElement(rootChildren, "product");
  const models = elements(elementChildren(meta, "meta"), "model").map(
    attributes,
  );
  if (models.length === 0) {
    throw new AppError("UPSTREAM_ERROR");
  }

  const fieldSet = fields ? new Set(fields) : undefined;
  const blocks = elements(elementChildren(product, "product"), "time").map(
    (time, sequence): ForecastBlock => {
      const timeAttributes = attributes(time);
      const from = timeAttributes.from;
      const to = timeAttributes.to;
      if (!from || !to) {
        throw new AppError("UPSTREAM_ERROR");
      }
      const timeChildren = elementChildren(time, "time");
      const location = singleElement(timeChildren, "location");
      const values = directElements(elementChildren(location, "location"))
        .map(toForecastElement)
        .filter((element) => !fieldSet || fieldSet.has(element.name));
      return {
        kind: from === to ? "instant" : "interval",
        sequence,
        attributes: timeAttributes,
        location: {
          attributes: attributes(location),
          elements: values,
        },
      };
    },
  );

  return {
    metadata: {
      root_attributes: attributes(root),
      models,
    },
    productAttributes: attributes(product),
    blocks,
  };
}

function singleElement(nodes: unknown[], name: string): OrderedNode {
  const matches = elements(nodes, name);
  if (matches.length !== 1) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return matches[0]!;
}

function elements(nodes: unknown[], name: string): OrderedNode[] {
  return nodes.filter(
    (node): node is OrderedNode => isRecord(node) && Array.isArray(node[name]),
  );
}

function directElements(nodes: unknown[]): OrderedNode[] {
  return nodes.filter(
    (node): node is OrderedNode =>
      isRecord(node) &&
      Object.keys(node).some((key) => key !== ":@" && key !== "#text"),
  );
}

function elementChildren(node: OrderedNode, name: string): unknown[] {
  const value = node[name];
  if (!Array.isArray(value)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  return value;
}

function attributes(node: OrderedNode): Readonly<Record<string, string>> {
  const raw = node[":@"];
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith("@_") || typeof value !== "string") {
      throw new AppError("UPSTREAM_ERROR");
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function toForecastElement(node: OrderedNode): ForecastElement {
  const names = Object.keys(node).filter(
    (key) => key !== ":@" && key !== "#text",
  );
  if (names.length !== 1) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const name = names[0]!;
  const children = node[name];
  if (!Array.isArray(children)) {
    throw new AppError("UPSTREAM_ERROR");
  }
  const text = children
    .filter(isRecord)
    .map((child) => child["#text"])
    .filter((value): value is string => typeof value === "string")
    .join("");
  return {
    name,
    attributes: attributes(node),
    ...(text !== "" ? { text } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
