# React Component Usage Finder

A command-line tool for analyzing React component usage hierarchies in your project. This tool helps to understand where components are being used across codebase and visualizes the component relationships in a tree structure.

## Features

- Scans your React project for component usage
- Creates a visual tree representation of component hierarchy
- Shows file paths where components are defined
- Supports JavaScript and TypeScript files
- Copies output in Markdown format for easy sharing
- Handles both function declarations and arrow function components
- Ignores TypeScript declaration files (`.d.ts`)

## Prerequisites

- Node.js >= 18
- npm or yarn

## Installation

1. Clone the repository:

```bash
git clone <your-repo-url>
cd react-component-usage-finder
```

2. Install dependencies:

```bash
npm install
```

3. Make the script executable:

```bash
chmod +x main.js
```

4. Optional: Install globally to use from anywhere:

```bash
npm install -g .
```

## Usage

### Basic Usage

```bash
node main.js -c ComponentName
```

### Specify Directory

```bash
node main.js -d /path/to/project -c ComponentName
```

### If Installed Globally

```bash
react-component-usage-finder -c ComponentName
```

### Options

- `-c, --component`: Name of the component to analyze (required)
- `-d, --directory`: Root directory to scan (defaults to current directory)
- `-h, --help`: Show help

## Output Example

```text
└── Button (src/components/Button.tsx)
    ├── LoginForm (src/components/LoginForm.tsx)
    │   └── LoginPage (src/pages/LoginPage.tsx)
    └── SignupForm (src/components/SignupForm.tsx)
        └── SignupPage (src/pages/SignupPage.tsx)
```

The tool will prompt you to copy the output to your clipboard in Markdown format, which is useful for documentation.

## Limitations

- Only analyzes static imports and JSX usage
- Does not track dynamic component rendering (e.g., using `React.createElement`)
- Does not analyze string literals or variable component names
- Skips TypeScript declaration files (`.d.ts`)
