import { createContext } from 'react';

export const UsageChartHoverContext = createContext<{ date: string; setDate: (date: string) => void }>({ date: '', setDate: () => {} });
export const UsageModelHoverContext = createContext<{ id: string; setId: (id: string) => void }>({ id: '', setId: () => {} });
