/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-28
 * @modify date 2026-08-28
 * @desc Opaque cursor contracts shared by bounded host operations.
 */

export type PaginationRequest = Readonly<{
  cursor?: string;
  limit?: number;
}>;

export type PaginationResult = Readonly<{
  hasMore: boolean;
  nextCursor?: string;
}>;

export const END_OF_PAGE: PaginationResult = Object.freeze({ hasMore: false });
