/**
 * CLI output formatting helpers.
 */

import chalk from 'chalk';

export function table(headers: string[], rows: string[][]): void {
  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxRow = Math.max(...rows.map(r => (r[i] || '').length));
    return Math.max(h.length, maxRow);
  });

  // Print header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  console.log(chalk.bold(headerLine));
  console.log(chalk.dim('─'.repeat(headerLine.length)));

  // Print rows
  for (const row of rows) {
    const line = row.map((cell, i) => (cell || '').padEnd(widths[i])).join('  ');
    console.log(line);
  }
}

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function success(message: string): void {
  console.log(chalk.green('✓'), message);
}

export function warn(message: string): void {
  console.log(chalk.yellow('!'), message);
}

export function error(message: string): void {
  console.error(chalk.red('✗'), message);
}

export function info(message: string): void {
  console.log(chalk.cyan('i'), message);
}

export function statusBadge(status: string): string {
  const colours: Record<string, (s: string) => string> = {
    draft: chalk.dim,
    active: chalk.green,
    paused: chalk.yellow,
    completed: chalk.blue,
    archived: chalk.dim,
  };
  const fn = colours[status] || chalk.white;
  return fn(status);
}

export function confidenceBadge(confidence: string | null): string {
  if (!confidence) return chalk.dim('—');
  const colours: Record<string, (s: string) => string> = {
    High: chalk.green,
    Medium: chalk.yellow,
    Low: chalk.red,
  };
  const fn = colours[confidence] || chalk.white;
  return fn(confidence);
}

export function truncate(str: string | null | undefined, maxLen: number): string {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}
