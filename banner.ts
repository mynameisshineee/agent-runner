const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
} as const;

export const BIKLABS_ASCII = String.raw`
                ____      ____
           ____/ __ \____/ __ \____
        __/ __  /  \  /\  /  \  __ \__
       /  /  /_/ /\ \/  \/ /\ \_\  \  \
      |  |   ___/  \  /\  /  \___   |  |
      |  |  /___    \/  \/    ___\  |  |
       \  \____ \___  /\  ___/ ____/  /
        \_____/    /_/  \_\    \_____/
                 B I K L A B S
`;

export function printBiklabsBanner(title?: string): void {
  if (process.env.BIKLABS_NO_BANNER === "1" || process.env.BIKLABS_NO_BANNER === "true") {
    return;
  }

  const colorEnabled = process.env.NO_COLOR !== "1";
  const cyan = colorEnabled ? ANSI.cyan : "";
  const bold = colorEnabled ? ANSI.bold : "";
  const dim = colorEnabled ? ANSI.dim : "";
  const reset = colorEnabled ? ANSI.reset : "";

  process.stdout.write(`${bold}${cyan}${BIKLABS_ASCII}${reset}`);
  if (title) {
    process.stdout.write(`${dim}${title}${reset}\n\n`);
  } else {
    process.stdout.write("\n");
  }
}

