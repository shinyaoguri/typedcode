/**
 * Download Service
 *
 * Provides utilities for downloading files to the user's device.
 */

export interface DownloadOptions {
  /** MIME type of the content (default: 'application/octet-stream') */
  mimeType?: string;
  /** Whether to revoke the blob URL after download (default: true) */
  revokeUrl?: boolean;
}

/**
 * Download a string as a file
 *
 * @param content - String content to download
 * @param filename - Name of the file
 * @param options - Download options
 */
export function downloadString(
  content: string,
  filename: string,
  options: DownloadOptions = {}
): void {
  const { mimeType = 'text/plain', revokeUrl = true } = options;
  const blob = new Blob([content], { type: mimeType });
  downloadBlob(blob, filename, revokeUrl);
}

/**
 * Download JSON data as a file
 *
 * @param data - Object to serialize and download
 * @param filename - Name of the file (should end with .json)
 * @param options - Download options
 */
export function downloadJson(
  data: unknown,
  filename: string,
  options: Omit<DownloadOptions, 'mimeType'> & { pretty?: boolean } = {}
): void {
  const { pretty = true, revokeUrl = true } = options;
  const jsonString = pretty
    ? JSON.stringify(data, null, 2)
    : JSON.stringify(data);
  const blob = new Blob([jsonString], { type: 'application/json' });
  downloadBlob(blob, filename, revokeUrl);
}

/**
 * Download a Blob as a file
 *
 * @param blob - Blob to download
 * @param filename - Name of the file
 * @param revokeUrl - Whether to revoke the URL after download
 */
export function downloadBlob(
  blob: Blob,
  filename: string,
  revokeUrl: boolean = true
): void {
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  if (revokeUrl) {
    // Delay revocation to ensure download starts
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }
}

/**
 * Generate a timestamp string suitable for filenames
 */
export function generateTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Generate a filename with timestamp
 *
 * @param prefix - Filename prefix
 * @param extension - File extension (without dot)
 */
export function generateFilename(prefix: string, extension: string): string {
  return `${prefix}-${generateTimestamp()}.${extension}`;
}
