import {
  parse,
  type Redirect,
  type SimpleCommand,
  type Statement,
  type Word,
  type WordPart,
} from "@aliou/sh";

export type PythonCommand =
  | { kind: "inline"; source: string }
  | { kind: "file"; path: string };

const PYTHON = /^(?:[^\r\n]+\/)?python(?:[23](?:\.\d+)*)?$/u;
const FLAGS = new Set(["-u", "-B", "-E", "-I", "-s", "-S", "-O", "-OO"]);

/** A pending hint only. Complete commands still require structural validation. */
export function startsWithPython(command: string): boolean {
  const words = command.trimStart().split(/\s+/u);
  if (words.length === 0) return false;
  const [executable] = words;
  return PYTHON.test(executable);
}

/** Recognize presentation only. Never evaluate, rewrite, or execute shell input. */
export function recognizePython(command: string): PythonCommand | undefined {
  const simple = parseInvocation(command);
  if (!simple) return undefined;
  const words = literalArguments(simple.words ?? []);
  if (!words?.length) return undefined;
  const [executable, ...args] = words;
  if (!PYTHON.test(executable)) return undefined;
  while (args.length) {
    const [flag] = args;
    if (!FLAGS.has(flag)) break;
    args.shift();
  }
  return simple.redirects?.length
    ? readHeredoc(simple, args, command)
    : readScriptArgument(args);
}

function parseInvocation(command: string): SimpleCommand | undefined {
  if (command.length > 128 * 1024) return undefined;
  try {
    const { ast, errors } = parse(command);
    if (errors?.length || ast.body.length !== 1) return undefined;
    const [statement] = ast.body;
    return unwrappedInvocation(statement);
  } catch {
    // Incomplete or unsupported shell syntax keeps the normal Bash view.
    return undefined;
  }
}

function unwrappedInvocation(statement: Statement): SimpleCommand | undefined {
  if (statement.background || statement.negated) return undefined;
  const simple = statement.command;
  if (simple?.type !== "SimpleCommand" || simple.assignments?.length)
    return undefined;
  return simple;
}

function literalArguments(words: Word[]): string[] | undefined {
  const values: string[] = [];
  for (const word of words) {
    const value = literalWord(word);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function readScriptArgument(args: string[]): PythonCommand | undefined {
  if (args.length === 0) return undefined;
  const [mode, ...rest] = args;
  if (mode === "-c" && rest.length > 0) {
    const [source] = rest;
    return { kind: "inline", source };
  }
  if (!mode.startsWith("-") && mode.endsWith(".py")) {
    return { kind: "file", path: mode };
  }
  return undefined;
}

function readsStdin(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.length !== 1) return false;
  const [mode] = args;
  return mode === "-";
}

function readHeredoc(
  simple: SimpleCommand,
  args: string[],
  command: string,
): PythonCommand | undefined {
  if (!readsStdin(args) || simple.redirects?.length !== 1) return undefined;
  const [redirect] = simple.redirects;
  const delimiter = quotedDelimiter(redirect);
  if (!delimiter) return undefined;
  const headerLine = simple.pos?.line;
  const headerWords = [...(simple.words ?? []), redirect.target];
  if (headerWords.some((word) => word.pos?.line !== headerLine))
    return undefined;
  const source = heredocBody(command, delimiter);
  return source === undefined ? undefined : { kind: "inline", source };
}

function quotedDelimiter(redirect: Redirect): string | undefined {
  if (redirect.op !== "<<" || redirect.fd !== undefined || !redirect.heredoc)
    return undefined;
  if (redirect.target.parts.length !== 1) return undefined;
  const [part] = redirect.target.parts;
  if (part.type !== "SglQuoted" && part.type !== "DblQuoted") return undefined;
  const delimiter = literalWord(redirect.target);
  return delimiter && /^\w+$/u.test(delimiter) ? delimiter : undefined;
}

function heredocBody(command: string, delimiter: string): string | undefined {
  // The parser can fold commands after a heredoc into its words. Check the
  // physical terminator too, so a Python label never conceals another job.
  const lines = command.split("\n");
  while (lines.at(-1) === "") lines.pop();
  if (lines.length < 3) return undefined;
  const [header, ...body] = lines;
  if (!header || body.pop() !== delimiter || body.includes(delimiter))
    return undefined;
  return body.join("\n");
}

function literalWord(word: Word): string | undefined {
  // Reject concatenation, dollar quotes, substitutions, and glob expansion.
  if (word.parts.length !== 1) return undefined;
  const [part] = word.parts;
  return literalPart(part);
}

function literalPart(part: WordPart): string | undefined {
  if (part.type === "SglQuoted") return part.value;
  if (part.type === "Literal") {
    return /[\\~*?{}$`]/u.test(part.value) ? undefined : part.value;
  }
  if (part.type === "DblQuoted") {
    if (
      part.parts.some(
        (child) => child.type !== "Literal" || /[\\$`]/u.test(child.value),
      )
    )
      return undefined;
    return part.parts
      .map((child) => (child.type === "Literal" ? child.value : ""))
      .join("");
  }
  return undefined;
}
