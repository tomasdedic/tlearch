/**
 * Exercise 04-ink/01-hello.tsx
 *
 * CONCEPTS: render, Box, Text, colors, borders, useApp, useInput
 *
 * Run with: npm run ex exercises/04-ink/01-hello.tsx
 *
 * Ink renders React components to the terminal instead of the DOM.
 * <Box> = a flexbox container (uses Yoga layout engine, same as React Native).
 * <Text> = the only way to display text — everything must be inside <Text>.
 *
 * Key rule: you can ONLY nest <Text> inside <Text> or <Box> inside <Box>.
 * You cannot put raw strings or <Box> directly inside <Text>.
 */

import { Box, Text, render, useApp, useInput } from "ink";

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

// A section header — reusable, typed props:
function Header({ title }: { title: string }) {
	return (
		<Box marginBottom={1}>
			<Text bold color="cyan">
				{title}
			</Text>
		</Box>
	);
}

// Demonstrates all Text styling options:
function TextStyles() {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Header title="Text Styles" />
			<Text color="green">green text</Text>
			<Text color="red">red text</Text>
			<Text color="yellow">yellow text</Text>
			<Text color="blue">blue text</Text>
			<Text color="magenta">magenta text</Text>
			<Text bold>bold text</Text>
			<Text italic>italic text</Text>
			<Text underline>underline text</Text>
			<Text strikethrough>strikethrough text</Text>
			<Text dimColor>dimmed text</Text>
			{/* Combine styles: */}
			<Text bold color="green">
				bold green
			</Text>
			{/* Background colors: */}
			<Text backgroundColor="blue" color="white">
				{" white on blue "}
			</Text>
		</Box>
	);
}

// Demonstrates Box layout: borders and padding:
function BoxStyles() {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Header title="Box Borders" />
			<Box borderStyle="single" padding={1} marginBottom={1}>
				<Text>single border</Text>
			</Box>
			<Box borderStyle="double" padding={1} marginBottom={1}>
				<Text>double border</Text>
			</Box>
			<Box borderStyle="round" padding={1} marginBottom={1}>
				<Text>round border</Text>
			</Box>
			<Box borderStyle="bold" padding={1}>
				<Text>bold border</Text>
			</Box>
		</Box>
	);
}

// Demonstrates Box layout: flex direction and gap:
function LayoutDemo() {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Header title="Flex Layout" />
			{/* Row (default): */}
			<Box gap={2} marginBottom={1}>
				<Box borderStyle="single" paddingX={1}>
					<Text color="green">left</Text>
				</Box>
				<Box borderStyle="single" paddingX={1}>
					<Text color="yellow">center</Text>
				</Box>
				<Box borderStyle="single" paddingX={1}>
					<Text color="red">right</Text>
				</Box>
			</Box>
			{/* Column: */}
			<Box flexDirection="column" borderStyle="round" padding={1} width={20}>
				<Text>row one</Text>
				<Text>row two</Text>
				<Text>row three</Text>
			</Box>
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

function App() {
	const { exit } = useApp();

	// useInput fires on every keypress.
	// Press 'q' or Escape to exit.
	useInput((input, key) => {
		if (input === "q" || key.escape) {
			exit();
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<TextStyles />
			<BoxStyles />
			<LayoutDemo />
			<Text dimColor>Press q or Esc to exit</Text>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add a <ColorPalette> component that renders all 8 basic colors as colored
 *    boxes in a row, each showing its own name (e.g. a green box with "green").
 *
 * 2. Add a <StatusBar> component that renders a fixed-width bar at the bottom
 *    showing: left-aligned "ts-learning" and right-aligned "q: quit".
 *    Use justifyContent="space-between" and width={process.stdout.columns}.
 *
 * 3. Make the border color of a Box change based on a prop:
 *    <ColoredBox color="red" label="error" />
 *    <ColoredBox color="green" label="ok" />
 *    Hint: borderColor prop on <Box>.
 */
