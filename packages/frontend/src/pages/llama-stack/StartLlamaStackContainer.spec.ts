/**********************************************************************
 * Copyright (C) 2025 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import '@testing-library/jest-dom/vitest';
import { assert, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import StartLlamaStackContainer from '/@/pages/llama-stack/StartLlamaStackContainer.svelte';
import { llamaStackClient, studioClient } from '/@/utils/client';
import type { ContainerProviderConnectionInfo } from '@shared/models/IContainerConnectionInfo';
import { VMType } from '@shared/models/IPodman';
import userEvent from '@testing-library/user-event';
import * as tasks from '/@/stores/tasks';
import { writable } from 'svelte/store';
import { tick } from 'svelte';

vi.mock('../../stores/tasks', async () => {
  return {
    tasks: vi.fn(),
  };
});

const getContainerConnectionInfoMock = vi.fn();

vi.mock('../../stores/containerProviderConnections', () => ({
  containerProviderConnections: {
    subscribe: (f: (msg: unknown) => void) => {
      f(getContainerConnectionInfoMock());
      return (): void => {};
    },
  },
}));

vi.mock('../../utils/client', async () => ({
  llamaStackClient: {
    getLlamaStackContainerInfo: vi.fn(),
    routeToLlamaStackContainerTerminal: vi.fn().mockResolvedValue(undefined),
  },
  studioClient: {
    openURL: vi.fn().mockResolvedValue(true),
  },
  rpcBrowser: {
    subscribe: (): unknown => {
      return {
        unsubscribe: (): void => {},
      };
    },
  },
}));

const containerProviderConnection: ContainerProviderConnectionInfo = {
  name: 'Dummy container connection provider',
  status: 'started',
  type: 'podman',
  vmType: VMType.QEMU,
  providerId: 'podman',
};

beforeEach(() => {
  getContainerConnectionInfoMock.mockReturnValue([containerProviderConnection]);
  vi.mocked(tasks).tasks = writable([]);
});

test('start button should be displayed if no Llama Stack container', async () => {
  render(StartLlamaStackContainer);

  const startBtn = screen.getByTitle('Start Llama Stack container');
  expect(startBtn).toBeDefined();
});

test('Instructions block should not be displayed if no Llama Stack container', async () => {
  render(StartLlamaStackContainer);

  await tick();
  const instructions = screen.queryByText('Instructions');
  expect(instructions).not.toBeInTheDocument();
});

test('Instructions block should be displayed if Llama Stack container is found', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 0,
  });
  render(StartLlamaStackContainer);

  await vi.waitFor(() => screen.getByText('Instructions'));
});

test('start button should be displayed and enabled', async () => {
  render(StartLlamaStackContainer);

  const startBtn = screen.getByTitle('Start Llama Stack container');
  expect(startBtn).toBeDefined();
  expect(startBtn).toBeEnabled();
});

test('open button should be displayed if Llama Stack container is found', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 0,
  });
  render(StartLlamaStackContainer);

  await vi.waitFor(() => {
    const openBtn = screen.getByTitle('Open Llama Stack container');
    expect(openBtn).toBeDefined();
  });
});

test('playground button should be disabled if platground port is zero', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 0,
  });
  render(StartLlamaStackContainer);

  await vi.waitFor(() => {
    const playgroundBtn = screen.getByTitle('Explore LLama-Stack environment');
    expect(playgroundBtn).toBeDefined();
    expect(playgroundBtn).toBeDisabled();
  });
});

test('playground button should be enabled if platground port is not zero', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 10001,
  });
  render(StartLlamaStackContainer);

  await vi.waitFor(() => {
    const playgroundBtn = screen.getByTitle('Explore LLama-Stack environment');
    expect(playgroundBtn).toBeDefined();
    expect(playgroundBtn).toBeEnabled();
  });
});

test('click playground button should open url', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 10001,
  });
  render(StartLlamaStackContainer);

  const playgroundBtn = await vi.waitFor(() => {
    const playgroundBtn = screen.getByTitle('Explore LLama-Stack environment');
    expect(playgroundBtn).toBeDefined();
    return playgroundBtn;
  });

  await userEvent.click(playgroundBtn);
  expect(studioClient.openURL).toHaveBeenCalledWith('http://localhost:10001');
});

test('click open button should redirect to Llama Stack container', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 0,
  });
  render(StartLlamaStackContainer);

  const openBtn = await vi.waitFor(() => {
    const openBtn = screen.getByTitle('Open Llama Stack container');
    expect(openBtn).toBeDefined();
    return openBtn;
  });

  await userEvent.click(openBtn);
  expect(llamaStackClient.routeToLlamaStackContainerTerminal).toHaveBeenCalledWith('containerId');
});

test('port should be displayed', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 0,
  });
  render(StartLlamaStackContainer);

  await vi.waitFor(() => {
    screen.getByText(/http:\/\/localhost:10000/);
  });
});

test('link to Swagger UI should be displayed', async () => {
  vi.mocked(llamaStackClient.getLlamaStackContainerInfo).mockResolvedValue({
    containerId: 'containerId',
    port: 10000,
    playgroundPort: 0,
  });
  render(StartLlamaStackContainer);

  let link: HTMLElement | undefined;
  await vi.waitFor(() => {
    link = screen.getByText('swagger documentation');
  });
  assert(link, 'link should be defined');
  await fireEvent.click(link);
  expect(studioClient.openURL).toHaveBeenCalledWith('http://localhost:10000/docs');
});
