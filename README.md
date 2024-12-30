# Welcome to Patch Scripting Language

## Introduction

Patch is an innovative scripting language designed to bridge the gap between natural human language and traditional programming. By allowing developers to write code in virtually any human language, with a default in English, Patch aims to make programming more intuitive and accessible. This README is intended for developers interested in contributing to or developing with Patch. Join us in revolutionizing the way we think about coding!

## Project Overview

Patch uses advanced natural language processing techniques to interpret human-readable code into machine-readable formats across various programming languages, optimizing for the best runtime performance. Below, we outline the architecture and components that make Patch a versatile tool for developers.

## Key Components

### 1. **Patch IDE Console**

The development environment where you'll write and compile your `.p` files, using a user-friendly interface that supports direct input in human language.

### 2. **File Compilation**

Compiled Patch scripts are transformed into `.patch` files, which are compressed archives containing:
- **XML files:** These files store the cleaned, human-language code.
- **Conf files:** These files contain metadata, including environment variables and system configuration.

### 3. **Selector**

This component analyzes the XML and conf files to select the most optimized programming language for each piece of code based on performance metrics such as runtime.

### 4. **Mini LLM**

A miniature Language Learning Model (LLM) translates the cleaned human-language code into the targeted programming language. Patch currently supports Python, JavaScript, C, C++, Java, and PHP.

### 5. **Patcher**

Responsible for integrating and executing the disparate pieces of code, ensuring that variables and data shared across methods are handled correctly. It sequences the converted code files and manages their execution.

## Final Output

The final output of a Patch script remains a `.patch` file, which includes:
- The original XML and conf files.
- The executable output from the processed code.

## Coding Guidelines

- **Write Clearly:** Each line of code should contain only one sentence.
- **Declare Variables Early:** All variables should be declared at the beginning of the script, with initial values set using either sample data or a formatted value.

## Contribution Guide

Interested in contributing to Patch? We welcome developers of all skill levels and backgrounds! Here are a few ways you can get started:

- **Feature Development:** Help us expand the capabilities of Patch by developing new features or improving existing ones.
- **Language Support:** Assist in increasing the number of human languages Patch can interpret by contributing to our LLM.
- **Optimization:** Contribute to the optimization of code translation and execution, ensuring Patch runs efficiently across different environments.
- **Testing and Bug Fixes:** Help us refine Patch by testing for bugs and inconsistencies and providing fixes.

## Getting Started

Clone the repository, check out the latest issues, and make your first pull request! If you're new to the project, consider tackling some of our `good first issues`.

```bash
git clone https://github.com/michaelkhany/Patch.git
cd patch
# Start contributing!
```

## Join Our Community

Join our developer community to discuss the development and future of Patch. Share ideas, get feedback, and collaborate on this exciting project!

- **[Community Anounced Issues](https://github.com/michaelkhany/Patch/issues)**
- **[Developer Chat](https://michaelbkhani.t.me)**
- **[Documentation](https://github.com/michaelkhany/Patch/wiki)**

Thank you for your interest in contributing to the Patch project. We look forward to seeing your contributions and celebrating the innovative ways you use and improve Patch!
