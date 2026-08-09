// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PromptInput,
  PromptInputBody,
  PromptInputSubmit,
  PromptInputTextarea,
} from "./prompt-input";

afterEach(cleanup);

function renderPrompt(onSubmit: Parameters<typeof PromptInput>[0]["onSubmit"]) {
  return render(
    <PromptInput onSubmit={onSubmit}>
      <PromptInputBody>
        <PromptInputTextarea aria-label="Message" />
      </PromptInputBody>
      <PromptInputSubmit />
    </PromptInput>,
  );
}

describe("PromptInput", () => {
  it("does not submit while an IME composition is being confirmed", async () => {
    const onSubmit = vi.fn();
    const view = renderPrompt(onSubmit);
    const textarea = view.getByRole("textbox", { name: "Message" });

    fireEvent.change(textarea, { target: { value: "안녕하세요" } });
    fireEvent.keyDown(textarea, { isComposing: true, key: "Enter", keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      { text: "안녕하세요" },
      expect.objectContaining({ type: "submit" }),
    );
  });

  it("clears the box on dispatch, not when the reply finishes streaming", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onSubmit = vi.fn(() => pending);
    const view = renderPrompt(onSubmit);
    const textarea = view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const form = textarea.closest("form");
    if (!form) throw new Error("Prompt textarea must belong to a form");

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.submit(form);

    await waitFor(() => expect(textarea.value).toBe(""));
    expect(onSubmit).toHaveBeenCalledWith({ text: "hello" }, expect.anything());
    finish();
  });

  it("restores the text when the dispatch itself fails", async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error("transport down")));
    const view = renderPrompt(onSubmit);
    const textarea = view.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const form = textarea.closest("form");
    if (!form) throw new Error("Prompt textarea must belong to a form");

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.submit(form);

    await waitFor(() => expect(textarea.value).toBe("hello"));
  });

  it("coalesces rapid submits while the first submit is pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onSubmit = vi.fn(() => pending);
    const view = renderPrompt(onSubmit);
    const textarea = view.getByRole("textbox", { name: "Message" });
    const form = textarea.closest("form");
    if (!form) throw new Error("Prompt textarea must belong to a form");

    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.submit(form);
    // The box is already empty here, so re-type before the second submit —
    // otherwise the empty-text guard, not the in-flight guard, is what's tested.
    fireEvent.change(textarea, { target: { value: "hello again" } });
    fireEvent.submit(form);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((view.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    finish();
    await waitFor(() =>
      expect(
        (view.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
