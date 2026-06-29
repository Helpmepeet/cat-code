import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js';
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js';
import { Box, Text } from '../../ink.js';
import type { ProgressMessage } from '../../types/message.js';
import { truncate } from '../../utils/format.js';
import type { Output, SearchResult, WebSearchProgress } from './WebSearchTool.js';

function getResultCount(results: (SearchResult | null | undefined)[]): number {
  return results.filter(Boolean).length;
}

export function renderToolUseMessage({
  query,
  include_domains,
  exclude_domains,
  max_results,
  freshness
}: Partial<{
  query: string;
  include_domains?: string[];
  exclude_domains?: string[];
  max_results?: number;
  freshness?: string;
}>, {
  verbose
}: {
  verbose: boolean;
}): React.ReactNode {
  if (!query) {
    return null;
  }
  let message = '';
  if (query) {
    message += `"${query}"`;
  }
  if (verbose) {
    if (typeof max_results === 'number') {
      message += `, max results: ${max_results}`;
    }
    if (freshness && freshness !== 'any') {
      message += `, freshness: ${freshness}`;
    }
    if (include_domains && include_domains.length > 0) {
      message += `, only including domains: ${include_domains.join(', ')}`;
    }
    if (exclude_domains && exclude_domains.length > 0) {
      message += `, excluding domains: ${exclude_domains.join(', ')}`;
    }
  }
  return message;
}

export function renderToolUseProgressMessage(progressMessages: ProgressMessage<WebSearchProgress>[]): React.ReactNode {
  if (progressMessages.length === 0) {
    return null;
  }
  const lastProgress = progressMessages[progressMessages.length - 1];
  if (!lastProgress?.data) {
    return null;
  }
  const data = lastProgress.data;
  switch (data.type) {
    case 'query_update':
      return <MessageResponse>
          <Text dimColor>Searching: {data.query}</Text>
        </MessageResponse>;
    case 'search_results_received':
      return <MessageResponse>
          <Text dimColor>
            Found {data.resultCount} results for &quot;{data.query}&quot;
          </Text>
        </MessageResponse>;
    default:
      return null;
  }
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  const resultCount = getResultCount(output.results ?? []);
  const timeDisplay = output.durationSeconds >= 1 ? `${Math.round(output.durationSeconds)}s` : `${Math.round(output.durationSeconds * 1000)}ms`;
  return <Box justifyContent="space-between" width="100%">
      <MessageResponse height={1}>
        <Text>
          Found {resultCount} result
          {resultCount !== 1 ? 's' : ''} in {timeDisplay}
        </Text>
      </MessageResponse>
    </Box>;
}

export function getToolUseSummary(input: Partial<{
  query: string;
}> | undefined): string | null {
  if (!input?.query) {
    return null;
  }
  return truncate(input.query, TOOL_SUMMARY_MAX_LENGTH);
}
