import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DataSourceProvider } from '../lib/data/context';
import { MockDataSource } from '../lib/data/MockDataSource';
import type { DataSource } from '../lib/data/DataSource';
import { NewshackerConnection } from './NewshackerConnection';

const VALID_TOKEN = 'nht_abcdefghijklmnopqrstuv';

function setup() {
  const source = new MockDataSource(`nh-${Math.random()}`);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={client}>
      <DataSourceProvider source={source}>
        <NewshackerConnection />
      </DataSourceProvider>
    </QueryClientProvider>,
  );
  return source;
}

describe('<NewshackerConnection>', () => {
  it('renders nothing when the backend does not support linking', async () => {
    const source = {
      getNewshackerLink: async () => ({ linked: false, supported: false }),
    } as unknown as DataSource;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <DataSourceProvider source={source}>
          <NewshackerConnection />
        </DataSourceProvider>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(client.getQueryData(['newshacker-link'])).toEqual({
        linked: false,
        supported: false,
      }),
    );
    expect(screen.queryByLabelText(/newshacker token/i)).toBeNull();
    expect(
      screen.queryByRole('heading', { name: /newshacker/i }),
    ).toBeNull();
  });

  it('shows a token field when not linked', async () => {
    setup();
    expect(
      await screen.findByLabelText(/newshacker token/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect/i })).toBeInTheDocument();
    expect(
      screen.getByText(/settings → connected apps/i),
    ).toBeInTheDocument();
  });

  it('connects with a valid token, then shows Disconnect', async () => {
    setup();
    const input = await screen.findByLabelText(/newshacker token/i);
    fireEvent.change(input, { target: { value: VALID_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByText(/^Connected$/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /disconnect/i }),
    ).toBeInTheDocument();
  });

  it('surfaces an error for an invalid token', async () => {
    setup();
    const input = await screen.findByLabelText(/newshacker token/i);
    fireEvent.change(input, { target: { value: 'not-a-token' } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/valid/i);
  });

  it('disconnects back to the token field', async () => {
    const source = setup();
    await source.setNewshackerToken(VALID_TOKEN);
    // Re-render path: connect via the UI to reach the linked state deterministically.
    const input = await screen.findByLabelText(/newshacker token/i);
    fireEvent.change(input, { target: { value: VALID_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /disconnect/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/newshacker token/i)).toBeInTheDocument(),
    );
  });
});
