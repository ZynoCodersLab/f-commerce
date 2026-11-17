import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button, Dialog, Field, Input, Select, Textarea, Toast } from './primitives';

describe('primitives', () => {
  it('announces toast content politely and offers a close control', () => {
    let dismissed = 0;
    render(
      <Toast onDismiss={() => (dismissed += 1)}>
        <p>Profile updated</p>
      </Toast>,
    );

    const toast = screen.getByRole('status');
    expect(toast).toHaveAttribute('aria-live', 'polite');
    expect(toast).toHaveTextContent('Profile updated');

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(dismissed).toBe(1);
  });

  it('renders a toast without a close control when no dismiss handler is given', () => {
    render(<Toast>Saved</Toast>);

    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

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
});
