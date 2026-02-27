/**
 * Exercise 04-ink/04-layout.tsx
 *
 * CONCEPTS: flexbox in terminal, fixed widths, dynamic sizing, overflow
 *
 * Run with: npm run ex exercises/04-ink/04-layout.tsx
 *
 * Ink uses Yoga (the same flexbox engine as React Native).
 * Terminal layout is different from the browser:
 *   - Width is in characters (columns), height in lines (rows)
 *   - process.stdout.columns / process.stdout.rows = terminal dimensions
 *   - No scrolling by default — overflow is clipped or wraps
 *   - Ink re-renders on terminal resize if you listen for SIGWINCH
 */

import { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";

// ─── TERMINAL DIMENSIONS ──────────────────────────────────────────────────────

function useTerminalSize() {
	const [size, setSize] = useState({
		cols: process.stdout.columns ?? 80,
		rows: process.stdout.rows ?? 24,
	});

	useEffect(() => {
		const handler = () => setSize({ cols: process.stdout.columns, rows: process.stdout.rows });
		process.stdout.on("resize", handler);
		return () => { process.stdout.off("resize", handler); };
	}, []);

	return size;
}

// ─── 1. FLEX DIRECTION ────────────────────────────────────────────────────────

function FlexDirectionDemo() {
	return (
		<Box flexDirection="column" borderStyle="round" padding={1} marginBottom={1}>
			<Text bold underline>flexDirection</Text>
			<Box gap={2} marginTop={1}>
				{/* Row (default) */}
				<Box flexDirection="column">
					<Text dimColor>row (default)</Text>
					<Box flexDirection="row" gap={1} borderStyle="single">
						<Box borderStyle="single" paddingX={1}><Text color="red">A</Text></Box>
						<Box borderStyle="single" paddingX={1}><Text color="green">B</Text></Box>
						<Box borderStyle="single" paddingX={1}><Text color="blue">C</Text></Box>
					</Box>
				</Box>
				{/* Column */}
				<Box flexDirection="column">
					<Text dimColor>column</Text>
					<Box flexDirection="column" borderStyle="single">
						<Box borderStyle="single" paddingX={1}><Text color="red">A</Text></Box>
						<Box borderStyle="single" paddingX={1}><Text color="green">B</Text></Box>
						<Box borderStyle="single" paddingX={1}><Text color="blue">C</Text></Box>
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

// ─── 2. ALIGNMENT ─────────────────────────────────────────────────────────────

function AlignmentDemo() {
	return (
		<Box flexDirection="column" borderStyle="round" padding={1} marginBottom={1}>
			<Text bold underline>alignItems + justifyContent</Text>
			<Box gap={2} marginTop={1}>
				<Box flexDirection="column">
					<Text dimColor>justifyContent</Text>
					<Box flexDirection="column" gap={1} marginTop={1}>
						{(["flex-start", "center", "flex-end", "space-between"] as const).map((jc) => (
							<Box key={jc} flexDirection="column">
								<Text dimColor>{jc}</Text>
								<Box justifyContent={jc} width={24} borderStyle="single">
									<Text color="red">X</Text>
									<Text color="green">Y</Text>
								</Box>
							</Box>
						))}
					</Box>
				</Box>
				<Box flexDirection="column">
					<Text dimColor>alignItems</Text>
					<Box flexDirection="column" gap={1} marginTop={1}>
						{(["flex-start", "center", "flex-end"] as const).map((ai) => (
							<Box key={ai} flexDirection="column">
								<Text dimColor>{ai}</Text>
								<Box alignItems={ai} width={24} height={3} borderStyle="single">
									<Text color="cyan">*</Text>
								</Box>
							</Box>
						))}
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

// ─── 3. FLEX GROW / SHRINK / BASIS ────────────────────────────────────────────
// flexGrow: how much a box expands to fill remaining space (0 = no grow)
// flexShrink: how much a box shrinks when there's not enough space
// flexBasis: initial size before grow/shrink is applied

function FlexGrowDemo({ cols }: { cols: number }) {
	const totalWidth = Math.min(cols - 4, 60);

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} marginBottom={1}>
			<Text bold underline>flexGrow (total width: {totalWidth})</Text>
			<Box marginTop={1} flexDirection="column" gap={1}>
				<Text dimColor>flexGrow: 1 / 1 / 1 (equal thirds)</Text>
				<Box width={totalWidth}>
					<Box flexGrow={1} borderStyle="single" justifyContent="center"><Text color="red">1/3</Text></Box>
					<Box flexGrow={1} borderStyle="single" justifyContent="center"><Text color="green">1/3</Text></Box>
					<Box flexGrow={1} borderStyle="single" justifyContent="center"><Text color="blue">1/3</Text></Box>
				</Box>
				<Text dimColor>flexGrow: 1 / 2 / 1 (sidebar + main + sidebar)</Text>
				<Box width={totalWidth}>
					<Box flexGrow={1} borderStyle="single" justifyContent="center"><Text color="yellow">nav</Text></Box>
					<Box flexGrow={2} borderStyle="single" justifyContent="center"><Text color="cyan">main</Text></Box>
					<Box flexGrow={1} borderStyle="single" justifyContent="center"><Text color="magenta">aux</Text></Box>
				</Box>
				<Text dimColor>fixed left (20) + flexGrow right</Text>
				<Box width={totalWidth}>
					<Box width={20} borderStyle="single" justifyContent="center"><Text color="yellow">fixed 20</Text></Box>
					<Box flexGrow={1} borderStyle="single" justifyContent="center"><Text color="cyan">fills rest</Text></Box>
				</Box>
			</Box>
		</Box>
	);
}

// ─── 4. TEXT WRAP ─────────────────────────────────────────────────────────────

function TextWrapDemo() {
	const long = "The quick brown fox jumps over the lazy dog. TypeScript is great.";

	return (
		<Box flexDirection="column" borderStyle="round" padding={1} marginBottom={1}>
			<Text bold underline>Text wrap (width: 30)</Text>
			<Box marginTop={1} flexDirection="column" gap={1}>
				<Text dimColor>wrap (default)</Text>
				<Box width={30} borderStyle="single" padding={1}>
					<Text wrap="wrap">{long}</Text>
				</Box>
				<Text dimColor>truncate-end</Text>
				<Box width={30} borderStyle="single" padding={1}>
					<Text wrap="truncate-end">{long}</Text>
				</Box>
				<Text dimColor>truncate-middle</Text>
				<Box width={30} borderStyle="single" padding={1}>
					<Text wrap="truncate-middle">{long}</Text>
				</Box>
			</Box>
		</Box>
	);
}

// ─── 5. REAL-WORLD: TWO-PANE LAYOUT ──────────────────────────────────────────
// Sidebar (fixed) + main (fills rest) — common TUI pattern used in pi-mono.

function TwoPaneLayout({ cols, rows }: { cols: number; rows: number }) {
	const sidebarWidth = 20;
	const mainWidth = cols - sidebarWidth - 2; // account for borders
	const height = Math.min(rows - 20, 10);

	const items = ["Sessions", "Models", "Tools", "Extensions", "Settings"];

	return (
		<Box flexDirection="column" borderStyle="round" padding={1}>
			<Text bold underline>Two-pane layout ({cols}x{rows})</Text>
			<Box marginTop={1} height={height}>
				{/* Sidebar */}
				<Box width={sidebarWidth} flexDirection="column" borderStyle="single">
					<Box borderBottom paddingX={1}>
						<Text bold color="cyan">Menu</Text>
					</Box>
					{items.map((item) => (
						<Box key={item} paddingX={1}>
							<Text>{item}</Text>
						</Box>
					))}
				</Box>
				{/* Main area */}
				<Box flexGrow={1} width={mainWidth} flexDirection="column" borderStyle="single" padding={1}>
					<Text bold>Main Content</Text>
					<Text dimColor>This area fills the remaining width.</Text>
					<Text dimColor>In pi-mono this holds the chat, editor, or tool output.</Text>
				</Box>
			</Box>
		</Box>
	);
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

type Page = "flex" | "align" | "grow" | "wrap" | "pane";
const pages: Page[] = ["flex", "align", "grow", "wrap", "pane"];
const pageLabels: Record<Page, string> = {
	flex: "1:FlexDir",
	align: "2:Align",
	grow: "3:Grow",
	wrap: "4:Wrap",
	pane: "5:TwoPane",
};

function App() {
	const { exit } = useApp();
	const { cols, rows } = useTerminalSize();
	const [page, setPage] = useState<Page>("flex");

	useInput((input, key) => {
		if (key.escape || input === "q") exit();
		const idx = pages.indexOf(page);
		if (key.rightArrow || input === "l") setPage(pages[(idx + 1) % pages.length]);
		if (key.leftArrow || input === "h") setPage(pages[(idx - 1 + pages.length) % pages.length]);
		const num = Number.parseInt(input);
		if (!Number.isNaN(num) && num >= 1 && num <= pages.length) setPage(pages[num - 1]);
	});

	return (
		<Box flexDirection="column" padding={1}>
			{/* Tab bar */}
			<Box gap={2} marginBottom={1}>
				{pages.map((p) => (
					<Text key={p} bold={p === page} color={p === page ? "cyan" : undefined} dimColor={p !== page}>
						{pageLabels[p]}
					</Text>
				))}
			</Box>

			{page === "flex" && <FlexDirectionDemo />}
			{page === "align" && <AlignmentDemo />}
			{page === "grow" && <FlexGrowDemo cols={cols} />}
			{page === "wrap" && <TextWrapDemo />}
			{page === "pane" && <TwoPaneLayout cols={cols} rows={rows} />}

			<Text dimColor>left/right or 1-5 to switch tabs  q/Esc to exit</Text>
		</Box>
	);
}

render(<App />);

/**
 * TASK:
 *
 * 1. Add a "6:Padding" tab that demonstrates all padding/margin props:
 *    padding, paddingX, paddingY, paddingTop, paddingBottom, paddingLeft, paddingRight
 *    (and margin equivalents). Show each as a labeled colored box.
 *
 * 2. Add a <ProgressBar value={0..100} width={30}> component:
 *    Renders: [====>     ] 40%
 *    Hint: use "=".repeat(filled) + ">" + " ".repeat(empty)
 *    Where filled = Math.floor((value / 100) * (width - 2))
 *
 * 3. Build a <ThreePaneLayout> with: left sidebar (fixed 15), center (flexGrow=2),
 *    right panel (flexGrow=1). All three have scrollable content areas.
 *    This mirrors pi-mono's interactive mode layout.
 */
