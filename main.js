#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as parser from "@babel/parser";
import _traverse from "@babel/traverse";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import prompts from "prompts";
import clipboardy from "clipboardy";

const traverse = _traverse.default;

/** Tree characters used for formatting the component hierarchy */
const treeChars = {
  corner: "└── ",
  pipe: "│   ",
  tee: "├── ",
  blank: "    ",
};

/**
 * Checks if a string follows PascalCase naming convention
 * @param {string} str - The string to check
 * @returns {boolean} True if string is PascalCase
 */
function isPascalCase(str) {
  return /^[A-Z][A-Za-z0-9]*$/.test(str);
}

/**
 * Determines if an AST node represents a React component
 * @param {Object} node - The AST node to check
 * @returns {boolean} True if node is a React component declaration
 */
function isReactComponent(node) {
  return (
    node.type === "FunctionDeclaration" &&
    isPascalCase(node.id.name) &&
    node.params.length <= 1
  );
}

/**
 * Checks if a directory path should be ignored during scanning
 * @param {string} dirPath - The directory path to check
 * @returns {boolean} True if directory should be ignored
 */
function isNodeModulesOrBuild(dirPath) {
  const ignoredDirs = ["node_modules", "build", "dist", ".git"];
  return ignoredDirs.some((dir) => dirPath.includes(dir));
}

/**
 * Determines if a file is a React component file
 * @param {string} file - The filename to check
 * @returns {boolean} True if file is a React component file
 */
function isReactFile(file) {
  const testPattern = /\.(test|spec|stories)\.(js|jsx|tsx|ts)$/;
  return (
    file.match(/\.(js|jsx|tsx|ts)$/) &&
    !file.endsWith(".d.ts") &&
    !testPattern.test(file)
  );
}

/**
 * Analyzes a single file for React component definitions and usages
 * @param {string} filePath - Path to the file to analyze
 * @param {Map} componentUsages - Map to store component usage information
 * @param {Map} componentDefinitions - Map to store component definition locations
 */
async function analyzeFile(filePath, componentUsages, componentDefinitions) {
  const content = await fs.readFile(filePath, "utf-8");

  try {
    const ast = parser.parse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy"],
    });

    let currentComponent = null;

    traverse(ast, {
      FunctionDeclaration: (path) => {
        if (isReactComponent(path.node)) {
          currentComponent = path.node.id.name;
          componentDefinitions.set(currentComponent, filePath);
        }
      },

      VariableDeclarator: (path) => {
        if (
          path.node.init &&
          (path.node.init.type === "ArrowFunctionExpression" ||
            path.node.init.type === "FunctionExpression") &&
          path.node.id.type === "Identifier" &&
          isPascalCase(path.node.id.name)
        ) {
          currentComponent = path.node.id.name;
          componentDefinitions.set(currentComponent, filePath);
        }
      },

      JSXElement: (path) => {
        const elementName = path.node.openingElement.name.name;
        if (isPascalCase(elementName)) {
          if (!componentUsages.has(elementName)) {
            componentUsages.set(elementName, new Set());
          }
          if (currentComponent) {
            componentUsages.get(elementName).add({
              component: currentComponent,
              file: filePath,
              line: path.node.loc.start.line,
            });
          }
        }
      },
    });
  } catch (error) {
    console.error(`Error analyzing ${filePath}:`, error);
  }
}

/**
 * Recursively scans a directory for React component files
 * @param {string} dir - Directory to scan
 * @param {Map} componentUsages - Map to store component usage information
 * @param {Map} componentDefinitions - Map to store component definition locations
 */
async function scanDirectory(dir, componentUsages, componentDefinitions) {
  const files = await fs.readdir(dir);

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory() && !isNodeModulesOrBuild(fullPath)) {
      await scanDirectory(fullPath, componentUsages, componentDefinitions);
    } else if (isReactFile(file)) {
      await analyzeFile(fullPath, componentUsages, componentDefinitions);
    }
  }
}

/**
 * Builds a hierarchy of component usages
 * @param {string} componentName - Name of the component to analyze
 * @param {Map} componentUsages - Map of component usage information
 * @param {Map} componentDefinitions - Map of component definition locations
 * @param {Set} visited - Set of visited components (for circular reference detection)
 * @returns {Object} Hierarchy object representing component usage
 */
function getUsageHierarchy(
  componentName,
  componentUsages,
  componentDefinitions,
  visited = new Set()
) {
  if (visited.has(componentName)) {
    return { name: componentName, usedIn: ["Circular Reference"] };
  }

  visited.add(componentName);

  const usages = componentUsages.get(componentName) || new Set();
  const hierarchy = {
    name: componentName,
    definedIn: componentDefinitions.get(componentName),
    usedIn: Array.from(usages).map((usage) =>
      getUsageHierarchy(
        usage.component,
        componentUsages,
        componentDefinitions,
        new Set(visited)
      )
    ),
    locations: Array.from(usages).map((usage) => ({
      file: usage.file,
      line: usage.line,
    })),
  };

  return hierarchy;
}

/**
 * Formats a component hierarchy as a tree string
 * @param {Object} hierarchy - Component hierarchy object
 * @param {string} prefix - Current line prefix for tree formatting
 * @param {boolean} isLast - Whether this is the last item in its branch
 * @returns {string} Formatted tree string
 */
function formatHierarchy(hierarchy, prefix = "", isLast = true) {
  let result = "";

  const connector = isLast ? treeChars.corner : treeChars.tee;
  const componentName = hierarchy.name;
  const definedIn = hierarchy.definedIn
    ? ` (${path.relative(process.cwd(), hierarchy.definedIn)})`
    : "";

  result += `${prefix}${connector}${componentName}${definedIn}\n`;

  if (hierarchy.locations && hierarchy.locations.length > 0) {
    const locationPrefix = prefix + (isLast ? treeChars.blank : treeChars.pipe);
    hierarchy.locations.forEach((loc) => {
      result += `${locationPrefix}${treeChars.pipe}Used at: ${path.relative(
        process.cwd(),
        loc.file
      )}:${loc.line}\n`;
    });
  }

  const childPrefix = prefix + (isLast ? treeChars.blank : treeChars.pipe);

  if (hierarchy.usedIn && hierarchy.usedIn.length > 0) {
    hierarchy.usedIn.forEach((child, index) => {
      const isLastChild = index === hierarchy.usedIn.length - 1;
      result += formatHierarchy(child, childPrefix, isLastChild);
    });
  }

  return result;
}

/**
 * Formats a component hierarchy as a markdown list
 * @param {Object} hierarchy - Component hierarchy object
 * @param {string} parentPath - Current path in the component tree
 * @returns {string} Formatted markdown list
 */
function getMarkdownList(hierarchy, parentPath = "") {
  let result = "";
  const currentPath = parentPath
    ? `${parentPath} -> ${hierarchy.name}`
    : hierarchy.name;

  const definedIn = hierarchy.definedIn
    ? ` (defined in ${path.relative(process.cwd(), hierarchy.definedIn)})`
    : "";

  if (!hierarchy.usedIn || hierarchy.usedIn.length === 0) {
    result += `- ${currentPath}${definedIn}\n`;
    if (hierarchy.locations) {
      hierarchy.locations.forEach((loc) => {
        result += `  - Used at: ${path.relative(process.cwd(), loc.file)}:${
          loc.line
        }\n`;
      });
    }
  } else {
    result += `- ${currentPath}${definedIn}\n`;
  }

  if (hierarchy.usedIn && hierarchy.usedIn.length > 0) {
    hierarchy.usedIn.forEach((child) => {
      result += getMarkdownList(child, currentPath);
    });
  }

  return result;
}

/**
 * Calculates statistics for a component hierarchy
 * @param {Object} node - Current node in the hierarchy
 * @param {number} depth - Current depth in the tree
 * @param {Object} stats - Statistics object to update
 */
function calculateStats(node, depth, stats) {
  stats.totalComponents.add(node.name);
  stats.maxDepth = Math.max(stats.maxDepth, depth);
  if (node.definedIn) {
    stats.uniqueFiles.add(node.definedIn);
  }

  if (!node.usedIn || node.usedIn.length === 0) {
    stats.leafNodes++;
  } else {
    node.usedIn.forEach((child) => {
      calculateStats(child, depth + 1, stats);
    });
  }
}

/**
 * Gets statistics for a component hierarchy
 * @param {Object} hierarchy - Component hierarchy object
 * @returns {Object} Statistics about the component hierarchy
 */
function getStatistics(hierarchy) {
  const stats = {
    totalComponents: new Set(),
    maxDepth: 0,
    leafNodes: 0,
    uniqueFiles: new Set(),
  };

  calculateStats(hierarchy, 1, stats);

  return {
    totalComponents: stats.totalComponents.size,
    maxDepth: stats.maxDepth,
    leafNodes: stats.leafNodes,
    uniqueFiles: stats.uniqueFiles.size,
  };
}

/**
 * Formats statistics as a summary string
 * @param {Object} stats - Statistics object
 * @returns {string} Formatted summary
 */
function formatSummary(stats) {
  return `Summary:
• Total unique components: ${stats.totalComponents}
• Maximum depth: ${stats.maxDepth}
• Leaf usages: ${stats.leafNodes}
• Files involved: ${stats.uniqueFiles}\n`;
}

/**
 * Main analysis function that scans a directory and builds component hierarchy
 * @param {string} rootDir - Root directory to scan
 * @param {string} targetComponent - Name of the component to analyze
 * @returns {Promise<Object>} Component hierarchy object
 */
async function analyze(rootDir, targetComponent) {
  const componentUsages = new Map();
  const componentDefinitions = new Map();

  await scanDirectory(rootDir, componentUsages, componentDefinitions);
  return getUsageHierarchy(
    targetComponent,
    componentUsages,
    componentDefinitions
  );
}

const argv = yargs(hideBin(process.argv))
  .usage("Usage: $0 -d [directory] -c [component]")
  .option("d", {
    alias: "directory",
    describe: "Root directory to scan",
    default: process.cwd(),
    type: "string",
  })
  .option("c", {
    alias: "component",
    describe: "Component name to search for",
    demandOption: true,
    type: "string",
  })
  .option("m", {
    alias: "markdown",
    describe: "Output as markdown list",
    type: "boolean",
    default: false,
  })
  .help("h")
  .alias("h", "help").argv;

/**
 * Main CLI function
 */
async function main() {
  try {
    const hierarchy = await analyze(argv.directory, argv.component);
    const stats = getStatistics(hierarchy);
    console.log("\n" + formatSummary(stats));

    const viewResponse = await prompts([
      {
        type: "confirm",
        name: "viewList",
        message: "Would you like to see the detailed usage list?",
        initial: true,
      },
      {
        type: (prev) => (prev ? "select" : null),
        name: "format",
        message: "Select output format:",
        choices: [
          { title: "Tree view", value: "tree" },
          { title: "Markdown list", value: "markdown" },
        ],
        initial: 0,
      },
    ]);

    let output = "";
    if (viewResponse.viewList) {
      if (viewResponse.format === "markdown") {
        output = getMarkdownList(hierarchy);
        console.log("\nComponent Usage List:");
      } else {
        output = formatHierarchy(hierarchy);
        console.log("\nComponent Usage Tree:");
      }
      console.log(output);
    }

    const clipboardResponse = await prompts({
      type: "confirm",
      name: "copyToClipboard",
      message: "Copy output to clipboard?",
      initial: false,
    });

    if (clipboardResponse.copyToClipboard) {
      const markdownOutput =
        viewResponse.format === "markdown"
          ? `${formatSummary(stats)}\n${output}`
          : `\`\`\`text\n${formatSummary(stats)}\n${output}\`\`\``;
      await clipboardy.write(markdownOutput);
      console.log(
        "\n✓ Copied to clipboard" +
          (viewResponse.format === "markdown" ? "" : " in markdown format")
      );
    }
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}

export { analyze, formatHierarchy, getMarkdownList };
