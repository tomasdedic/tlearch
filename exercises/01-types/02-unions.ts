/**
 * Exercise 01-types/02-unions.ts
 *
 * CONCEPTS: union types, type narrowing, type guards, intersection types
 *
 * Run with: npm run ex exercises/01-types/02-unions.ts
 *
 * pi-mono uses union types for every event in the LLM streaming pipeline.
 * Each event has a different shape — TypeScript helps you handle each safely.
 */

// --- 1. BASIC UNION TYPES ---
// A value of union type A | B can be either A or B.

type Role = "user" | "assistant" | "tool"; // string literal union (like an enum)
type StopReason = "stop" | "max_tokens" | "tool_use" | "error";

// Union of different primitive types (rare but valid):
type IdOrNumber = string | number;

// --- 2. NARROWING WITH typeof ---
// TypeScript tracks what type something is inside an if branch.

function formatId(id: IdOrNumber): string {
  if (typeof id === "string") {
    // Inside here, TypeScript knows `id` is string
    return id.toUpperCase();
  }
  // Here TypeScript knows `id` is number
  return id.toFixed(0);
}

// --- 3. UNION OF OBJECT TYPES ---
// This is where unions get powerful — objects with different shapes.

type TextContent = {
  type: "text";
  text: string;
};

type ImageContent = {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  data: string; // base64
};

type ToolUseContent = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>; // unknown values in a string-keyed object
};

// Content can be any of the three shapes:
type Content = TextContent | ImageContent | ToolUseContent;

// --- 4. NARROWING WITH A DISCRIMINANT ---
// When each union member has a shared field with a unique literal value,
// TypeScript can narrow by checking that field.

function describeContent(content: Content): string {
  switch (content.type) {
    case "text":
      // TypeScript knows content is TextContent here
      return `text: "${content.text.slice(0, 50)}"`;
    case "image":
      // TypeScript knows content is ImageContent here
      return `image (${content.mediaType})`;
    case "tool_use":
      // TypeScript knows content is ToolUseContent here
      return `tool call: ${content.name}(${JSON.stringify(content.input)})`;
  }
  // TypeScript knows this is unreachable — all cases handled.
  // If you add a new Content variant and forget to handle it here,
  // the compiler will error. This is "exhaustiveness checking".
}

// --- 5. CUSTOM TYPE GUARDS ---
// A function that returns `value is SomeType` narrows the type in the caller.

function isTextContent(content: Content): content is TextContent {
  return content.type === "text";
}

function isImageContent(content: Content): content is ImageContent {
  return content.type === "image";
}

// --- 6. INTERSECTION TYPES ---
// A & B means the value must satisfy BOTH A and B simultaneously.
// Use for "a thing that is also a thing".

type Timestamped = {
  createdAt: number; // unix ms
};

type TimestampedContent = Content & Timestamped;

// --- 7. EXTRACTING UNION MEMBERS ---
// `Extract` and `Exclude` are built-in utility types.

type OnlyTextOrImage = Extract<Content, { type: "text" | "image" }>;
// Result: TextContent | ImageContent

type WithoutToolUse = Exclude<Content, { type: "tool_use" }>;
// Result: TextContent | ImageContent

// --- MAIN ---

function main() {
  const contents: Content[] = [
    { type: "text", text: "Hello from the agent!" },
    { type: "image", mediaType: "image/png", data: "abc123==" },
    {
      type: "tool_use",
      id: "call_1",
      name: "read_file",
      input: { path: "/etc/hosts" },
    },
  ];

  for (const content of contents) {
    console.log(describeContent(content));
  }

  // Custom type guard usage:
  const first = contents[0];
  if (isTextContent(first)) {
    console.log(`\nFirst content is text: "${first.text}"`);
  }

  // formatId works with both string and number:
  console.log(`\nformatId("abc") = ${formatId("abc")}`);
  console.log(`formatId(42) = ${formatId(42)}`);

  const stream: StreamEvent[] = [
    { type: "text_start" },
    { type: "text_delta", text: "Hello" },
    { type: "text_delta", text: " from" },
    { type: "text_delta", text: " the stream!" },
    { type: "text_end" },
    { type: "error", message: "hola" },
    { type: "done", stopReason: "stop" },
  ];
  for (const event of stream) {
    handleEvent(event);
  }
}

main();

/**
 * TASK:
 *
 * pi-mono defines streaming events as a union. Model this yourself:
 *
 * 1. Define these event types:
 *    - TextStartEvent:  { type: "text_start" }
 *    - TextDeltaEvent:  { type: "text_delta"; text: string }
 *    - TextEndEvent:    { type: "text_end" }
 *    - DoneEvent:       { type: "done"; stopReason: StopReason }
 *    - ErrorEvent:      { type: "error"; message: string }
 *
 * 2. Create a union: type StreamEvent = TextStartEvent | TextDeltaEvent | ...
 *
 * 3. Write a function `handleEvent(event: StreamEvent): void` using a switch
 *    on `event.type`. For text_delta, write to process.stdout.write(event.text).
 *    For done, log the stop reason. For error, log the error.
 *
 * 4. Simulate a stream: create an array of StreamEvent[] and loop over them
 *    calling handleEvent on each.
 */

type TextStartEvent = {
  type: "text_start";
};

type TextDeltaEvent = {
  type: "text_delta";
  text: string;
};

type TextEndEvent = {
  type: "text_end";
};

type DoneEvent = {
  type: "done";
  stopReason: StopReason;
};

type ErrorEvent = {
  type: "error";
  message: string;
};

type StreamEvent =
  | TextStartEvent
  | TextDeltaEvent
  | TextEndEvent
  | DoneEvent
  | ErrorEvent;

function handleEvent(event: StreamEvent): void {
  switch (event.type) {
    case "text_start":
      break;
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "text_end":
      process.stdout.write("\n");
      break;
    case "done":
      console.log(`\nStop reason: ${event.stopReason}`);
      break;
    case "error":
      console.log(`Error: ${event.message}`);
      break;
  }
}
