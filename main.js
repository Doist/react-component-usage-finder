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

class ComponentAnalyzer {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.componentUsages = new Map();
    this.componentDefinitions = new Map();
  }

  async analyze(targetComponent) {
    await this.scanDirectory(this.rootDir);
    return this.getUsageHierarchy(targetComponent);
  }

  async scanDirectory(dir) {
    const files = await fs.readdir(dir);

    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = await fs.stat(fullPath);

      if (stat.isDirectory() && !this.isNodeModulesOrBuild(fullPath)) {
        await this.scanDirectory(fullPath);
      } else if (this.isReactFile(file)) {
        await this.analyzeFile(fullPath);
      }
    }
  }

  isNodeModulesOrBuild(dirPath) {
    const ignoredDirs = ["node_modules", "build", "dist", ".git"];
    return ignoredDirs.some((dir) => dirPath.includes(dir));
  }

  isReactFile(file) {
    return file.match(/\.(js|jsx|tsx|ts)$/) && !file.endsWith(".d.ts");
  }

  async analyzeFile(filePath) {
    const content = await fs.readFile(filePath, "utf-8");

    try {
      const ast = parser.parse(content, {
        sourceType: "module",
        plugins: ["jsx", "typescript", "decorators-legacy"],
      });

      let currentComponent = null;

      traverse(ast, {
        FunctionDeclaration: (path) => {
          if (this.isReactComponent(path.node)) {
            currentComponent = path.node.id.name;
            this.componentDefinitions.set(currentComponent, filePath);
          }
        },

        VariableDeclarator: (path) => {
          if (
            path.node.init &&
            (path.node.init.type === "ArrowFunctionExpression" ||
              path.node.init.type === "FunctionExpression") &&
            path.node.id.type === "Identifier" &&
            this.isPascalCase(path.node.id.name)
          ) {
            currentComponent = path.node.id.name;
            this.componentDefinitions.set(currentComponent, filePath);
          }
        },

        JSXElement: (path) => {
          const elementName = path.node.openingElement.name.name;
          if (this.isPascalCase(elementName)) {
            if (!this.componentUsages.has(elementName)) {
              this.componentUsages.set(elementName, new Set());
            }
            if (currentComponent) {
              this.componentUsages.get(elementName).add(currentComponent);
            }
          }
        },
      });
    } catch (error) {
      console.error(`Error analyzing ${filePath}:`, error);
    }
  }

  getUsageHierarchy(componentName, visited = new Set()) {
    if (visited.has(componentName)) {
      return { name: componentName, usedIn: ["Circular Reference"] };
    }

    visited.add(componentName);

    const usages = this.componentUsages.get(componentName) || new Set();
    const hierarchy = {
      name: componentName,
      definedIn: this.componentDefinitions.get(componentName),
      usedIn: Array.from(usages).map((parent) =>
        this.getUsageHierarchy(parent, new Set(visited))
      ),
    };

    return hierarchy;
  }

  isPascalCase(str) {
    return /^[A-Z][A-Za-z0-9]*$/.test(str);
  }

  isReactComponent(node) {
    return (
      node.type === "FunctionDeclaration" &&
      this.isPascalCase(node.id.name) &&
      node.params.length <= 1
    );
  }
}

class TreeFormatter {
  constructor() {
    this.treeChars = {
      corner: "└── ",
      pipe: "│   ",
      tee: "├── ",
      blank: "    ",
    };
  }

  formatHierarchy(hierarchy, prefix = "", isLast = true) {
    let result = "";

    // Format current node
    const connector = isLast ? this.treeChars.corner : this.treeChars.tee;
    const componentName = hierarchy.name;
    const definedIn = hierarchy.definedIn
      ? ` (${path.relative(process.cwd(), hierarchy.definedIn)})`
      : "";

    result += `${prefix}${connector}${componentName}${definedIn}\n`;

    // Format children
    const childPrefix =
      prefix + (isLast ? this.treeChars.blank : this.treeChars.pipe);

    if (hierarchy.usedIn && hierarchy.usedIn.length > 0) {
      hierarchy.usedIn.forEach((child, index) => {
        const isLastChild = index === hierarchy.usedIn.length - 1;
        result += this.formatHierarchy(child, childPrefix, isLastChild);
      });
    }

    return result;
  }

  getLeafUsages(hierarchy) {
    // If there are no children, this is a leaf node
    if (!hierarchy.usedIn || hierarchy.usedIn.length === 0) {
      return 1;
    }

    // If there are children, recursively count their leaves
    return hierarchy.usedIn.reduce(
      (sum, child) => sum + this.getLeafUsages(child),
      0
    );
  }

  getMarkdownList(hierarchy, parentPath = "") {
    let result = "";
    const currentPath = parentPath
      ? `${parentPath} -> ${hierarchy.name}`
      : hierarchy.name;

    // If this is a leaf node (no further usages), add a list item
    if (!hierarchy.usedIn || hierarchy.usedIn.length === 0) {
      result += `- ${currentPath}\n`;
    }

    // Recursively process children
    if (hierarchy.usedIn && hierarchy.usedIn.length > 0) {
      hierarchy.usedIn.forEach((child) => {
        result += this.getMarkdownList(child, currentPath);
      });
    }

    return result;
  }

  getStatistics(hierarchy) {
    const stats = {
      totalComponents: new Set(),
      maxDepth: 0,
      leafNodes: 0,
      uniqueFiles: new Set(),
    };

    this.calculateStats(hierarchy, 1, stats);

    return {
      totalComponents: stats.totalComponents.size,
      maxDepth: stats.maxDepth,
      leafNodes: stats.leafNodes,
      uniqueFiles: stats.uniqueFiles.size,
    };
  }

  calculateStats(node, depth, stats) {
    stats.totalComponents.add(node.name);
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (node.definedIn) {
      stats.uniqueFiles.add(node.definedIn);
    }

    if (!node.usedIn || node.usedIn.length === 0) {
      stats.leafNodes++;
    } else {
      node.usedIn.forEach((child) => {
        this.calculateStats(child, depth + 1, stats);
      });
    }
  }

  formatSummary(stats) {
    return `Summary:
• Total unique components: ${stats.totalComponents}
• Maximum depth: ${stats.maxDepth}
• Leaf usages: ${stats.leafNodes}
• Files involved: ${stats.uniqueFiles}\n`;
  }
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

async function main() {
  try {
    const analyzer = new ComponentAnalyzer(argv.directory);
    const hierarchy = await analyzer.analyze(argv.component);
    const formatter = new TreeFormatter();

    // Calculate and display statistics
    const stats = formatter.getStatistics(hierarchy);
    console.log("\n" + formatter.formatSummary(stats));

    // Prompt for viewing the list
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
        output = formatter.getMarkdownList(hierarchy);
        console.log("\nComponent Usage List:");
      } else {
        output = formatter.formatHierarchy(hierarchy);
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
          ? `${formatter.formatSummary(stats)}\n${output}`
          : `\`\`\`text\n${formatter.formatSummary(stats)}\n${output}\`\`\``;
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

export { ComponentAnalyzer, TreeFormatter };
