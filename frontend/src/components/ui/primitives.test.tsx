import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, Dialog, Field, Input, Select, Textarea } from './primitives';

describe('primitives', () => {
  it('associates a field error and description with the control', () => {
    render(
      <Field
        description="Shown on the storefront"
        error="Name is required"
        htmlFor="product-name"
        label="Product name"
      >
        <Input id="product-name" />
      </Field>,
    );

    const input = screen.getByLabelText('Product name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute(
      'aria-describedby',
      'product-name-description product-name-error',
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required');
  });

  it('describes Select and Textarea controls through the field context', () => {
    render(
      <>
        <Field
          description="Pick one"
          error="Category is required"
          htmlFor="product-category"
          label="Category"
        >
          <Select id="product-category">
            <option value="">Choose</option>
          </Select>
        </Field>
        <Field htmlFor="product-description" label="Description">
          <Textarea id="product-description" />
        </Field>
      </>,
    );

    const select = screen.getByLabelText('Category');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    expect(select).toHaveAttribute(
      'aria-describedby',
      'product-category-description product-category-error',
    );

    const textarea = screen.getByLabelText('Description');
    expect(textarea).not.toHaveAttribute('aria-invalid');
    expect(textarea).not.toHaveAttribute('aria-describedby');
  });

  it('keeps tab focus inside an open dialog', () => {
    render(
      <Dialog onClose={() => {}} open title="Confirm">
        <Button type="button">First</Button>
        <Button type="button">Last</Button>
      </Dialog>,
    );

    const close = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Last' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('pulls focus back into an open dialog when focus sits outside it', () => {
    render(
      <>
        <button type="button">Outside</button>
        <Dialog onClose={() => {}} open title="Confirm">
          <Button type="button">First</Button>
          <Button type="button">Last</Button>
        </Dialog>
      </>,
    );

    const outside = screen.getByRole('button', { name: 'Outside' });
    const close = screen.getByRole('button', { name: 'Close dialog' });
    const last = screen.getByRole('button', { name: 'Last' });

    // A backdrop click leaves focus on the page body. Tab must enter the
    // dialog instead of moving through the page behind it.
    outside.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    outside.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  // covers spec 0010 AC-19
  it('returns nothing when closed and links title and optional description when open', () => {
    const { rerender } = render(
      <Dialog onClose={vi.fn()} open={false} title="Record payment">
        <p>Body</p>
      </Dialog>,
    );

    expect(screen.queryByRole('dialog')).toBeNull();

    rerender(
      <Dialog
        description="Add a payment to this order."
        onClose={vi.fn()}
        open
        title="Record payment"
      >
        <p>Body</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Record payment' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const description = screen.getByText('Add a payment to this order.');
    expect(description.id).not.toBe('');
    expect(dialog).toHaveAttribute('aria-describedby', description.id);
    expect(screen.getByText('Body')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeVisible();

    rerender(
      <Dialog onClose={vi.fn()} open title="Record payment">
        <p>Body</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Record payment' })).not.toHaveAttribute(
      'aria-describedby',
    );
  });

  // covers spec 0010 AC-19
  it('closes on Escape and Close dialog click and restores focus to the trigger', async () => {
    const user = userEvent.setup();

    function DialogHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            Open payment dialog
          </button>
          <Dialog onClose={() => setOpen(false)} open={open} title="Record payment">
            <p>Payment amount</p>
            <Button type="button">Save payment</Button>
          </Dialog>
        </>
      );
    }

    render(<DialogHarness />);

    const trigger = screen.getByRole('button', { name: 'Open payment dialog' });
    await user.click(trigger);

    expect(screen.getByRole('dialog', { name: 'Record payment' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save payment' })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Record payment' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
