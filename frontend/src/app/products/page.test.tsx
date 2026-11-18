import { screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test-utils/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategoryDto, ProductDto } from '@f-commerce/contracts';

import { ThemeBoundary } from '@/components/theme/theme';
import { setAuth } from '@/lib/auth-client';

const replaceMock = vi.fn();
const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/products',
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useParams: () => ({ id: 'product-1' }),
}));

import ProductsPage from './page';

const category: CategoryDto = {
  id: 'cat-1',
  name: 'Tops',
  description: null,
  version: 1,
  createdAt: '2026-10-18T10:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
};

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeProduct(overrides: Partial<ProductDto> = {}): ProductDto {
  return {
    id: 'product-1',
    name: 'Oxford shirt',
    description: null,
    categoryId: category.id,
    categoryName: category.name,
    sku: 'SHIRT-1',
    price: 500,
    cost: null,
    stockCount: 3,
    lowStockThreshold: 5,
    availableStock: 3,
    stockStatus: 'lowStock',
    images: [],
    options: [],
    variants: [],
    isArchived: false,
    archivedAt: null,
    version: 1,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installedFetch(
  handler: (url: string, init?: RequestInit) => Response | undefined,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(
      handler(String(input), init) ??
        jsonResponse(404, { error: 'NOT_FOUND', message: 'Not found' }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage() {
  return render(
    <ThemeBoundary>
      <ProductsPage />
    </ThemeBoundary>,
  );
}

describe('ProductsPage', () => {
  beforeEach(() => {
    replaceMock.mockReset();
    pushMock.mockReset();
    setAuth({ accessToken: 'tok', businessId: 'biz-1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refetches the previous page instead of replaying a cached snapshot', async () => {
    let firstPageCalls = 0;
    installedFetch((url) => {
      if (url.startsWith('/api/products?')) {
        if (url.includes('cursor=cursor-1')) {
          return jsonResponse(200, {
            success: true,
            data: {
              items: [makeProduct({ id: 'product-2', name: 'Second page' })],
              nextCursor: null,
            },
          });
        }
        firstPageCalls += 1;
        return jsonResponse(200, {
          success: true,
          data: {
            items: [
              makeProduct({
                id: 'product-1',
                name: firstPageCalls === 1 ? 'First page' : 'Fresh first page',
              }),
            ],
            nextCursor: 'cursor-1',
          },
        });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    const user = userEvent.setup();
    renderPage();

    expect((await screen.findAllByRole('link', { name: 'First page' }))[0]).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findAllByRole('link', { name: 'Second page' }))[0]).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect((await screen.findAllByRole('link', { name: 'Fresh first page' }))[0]).toBeVisible();
    expect(firstPageCalls).toBe(2);
  });

  it('renders products with price, stock, and the active navigation item', async () => {
    installedFetch((url) => {
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [makeProduct()], nextCursor: null },
        });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();

    expect(await screen.findByRole('heading', { name: 'Products' })).toBeVisible();
    const links = await screen.findAllByRole('link', { name: 'Oxford shirt' });
    expect(links[0]).toHaveAttribute('href', '/products/product-1');
    expect(screen.getAllByText('500 BDT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Low stock').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SHIRT-1').length).toBeGreaterThan(0);

    const productLinks = screen.getAllByRole('link', { name: 'Products' });
    expect(productLinks.length).toBeGreaterThan(0);
    for (const link of productLinks) {
      expect(link).toHaveAttribute('aria-current', 'page');
    }
  });

  it('shows the primary image and a placeholder when absent', async () => {
    const imageUrl = 'https://res.cloudinary.com/demo/image/upload/main.png';
    installedFetch((url) => {
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, {
          success: true,
          data: {
            items: [
              makeProduct({ images: [imageUrl] }),
              makeProduct({ id: 'product-2', name: 'Plain tee', sku: 'TEE-2' }),
            ],
            nextCursor: null,
          },
        });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();

    const images = await screen.findAllByRole('img', { name: 'Oxford shirt image' });
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toHaveAttribute('src', imageUrl);
    }
    expect(screen.queryByRole('img', { name: 'Plain tee image' })).not.toBeInTheDocument();
  });

  // covers AC-14: the first list load is announced, not just drawn as skeletons
  it('announces the first list load', () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/products?')) {
        return new Promise<Response>(() => {});
      }
      if (url === '/api/categories') {
        return Promise.resolve(jsonResponse(200, { success: true, data: [category] }));
      }
      return Promise.resolve(jsonResponse(200, { success: true, data: { currency: 'BDT' } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPage();

    const loading = screen.getByText('Loading products…');
    expect(loading.closest('[role="status"]')).not.toBeNull();
    expect(loading).toHaveClass('sr-only');
  });

  it('shows the empty catalog state and the add action', async () => {
    installedFetch((url) => {
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: [], nextCursor: null } });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();

    const empty = await screen.findByText('No products yet');
    expect(empty).toBeVisible();
    expect(empty.closest('[role="status"]')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: /add product/i }).length).toBeGreaterThan(0);
  });

  it('sends the category filter to the next product request', async () => {
    const user = userEvent.setup();
    const fetchMock = installedFetch((url) => {
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, {
          success: true,
          data: { items: [makeProduct()], nextCursor: null },
        });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();
    await screen.findAllByRole('link', { name: 'Oxford shirt' });

    await user.selectOptions(screen.getByLabelText('Category'), category.id);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('categoryId=cat-1')),
      ).toBe(true);
    });
  });

  it('shows a load error and retries the product page', async () => {
    let productCalls = 0;
    installedFetch((url) => {
      if (url.startsWith('/api/products?')) {
        productCalls += 1;
        if (productCalls === 1) {
          return jsonResponse(500, {
            error: 'INTERNAL_ERROR',
            message: 'Catalog unavailable',
          });
        }
        return jsonResponse(200, {
          success: true,
          data: { items: [makeProduct()], nextCursor: null },
        });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server could not complete the request. Try again.',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findAllByRole('link', { name: 'Oxford shirt' })).not.toHaveLength(0);
  });

  it('creates a product and reloads the catalog', async () => {
    const user = userEvent.setup();
    let products: ProductDto[] = [];
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/products' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as {
          name: string;
          price: number;
          sku?: string;
        };
        const created = makeProduct({
          id: 'product-2',
          name: payload.name,
          price: payload.price,
          sku: payload.sku ?? null,
        });
        products = [created];
        return jsonResponse(201, { success: true, data: created });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: products, nextCursor: null } });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();
    await screen.findByText('No products yet');

    await user.click(screen.getAllByRole('button', { name: /add product/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Add product' });

    await user.type(within(dialog).getByLabelText('Product name'), 'New shirt');
    await user.type(within(dialog).getByLabelText('Price'), '1200');
    await user.click(within(dialog).getByRole('button', { name: 'Save product' }));

    await waitFor(() => {
      expect(screen.getByText('New shirt was added')).toBeVisible();
    });
    expect(await screen.findAllByRole('link', { name: 'New shirt' })).not.toHaveLength(0);

    const postCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input) === '/api/products' && (init as RequestInit | undefined)?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(String((postCall?.[1] as RequestInit).body)) as {
      categoryId: string;
      price: number;
    };
    expect(body.categoryId).toBe(category.id);
    expect(body.price).toBe(1200);
  });

  it('uploads a selected variant image after creating the product', async () => {
    const user = userEvent.setup();
    let products: ProductDto[] = [];
    const fetchMock = installedFetch((url, init) => {
      if (url === '/api/products' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { name: string; price: number };
        const created = makeProduct({
          id: 'product-3',
          name: payload.name,
          price: payload.price,
          stockCount: 0,
          availableStock: 0,
          stockStatus: 'outOfStock',
          options: [{ name: 'Size', values: ['S', 'M'] }],
          variants: [
            {
              combination: { Size: 'S' },
              sku: null,
              price: null,
              cost: null,
              stockCount: 0,
              imageUrl: null,
              stockStatus: 'outOfStock',
            },
            {
              combination: { Size: 'M' },
              sku: null,
              price: null,
              cost: null,
              stockCount: 0,
              imageUrl: null,
              stockStatus: 'outOfStock',
            },
          ],
        });
        products = [created];
        return jsonResponse(201, { success: true, data: created });
      }
      if (url === '/api/products/product-3/variants/0/image' && init?.method === 'POST') {
        return jsonResponse(200, { success: true, data: products[0] });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: products, nextCursor: null } });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [category] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();
    await screen.findByText('No products yet');

    await user.click(screen.getAllByRole('button', { name: /add product/i })[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Add product' });
    await user.type(within(dialog).getByLabelText('Product name'), 'Variant shirt');
    await user.type(within(dialog).getByLabelText('Price'), '900');
    await user.click(within(dialog).getByRole('button', { name: 'Add option' }));
    await user.type(within(dialog).getByLabelText('Option name'), 'Size');
    await user.type(within(dialog).getByLabelText('Values'), 'S, M');

    const variantFile = new File([PNG_BYTES], 'variant.png', { type: 'image/png' });
    await user.upload(within(dialog).getByLabelText('Image for S'), variantFile);
    expect(await within(dialog).findByText('Selected: variant.png')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Save product' }));

    await waitFor(
      () => {
        expect(
          fetchMock.mock.calls.some(
            ([input]) => String(input) === '/api/products/product-3/variants/0/image',
          ),
        ).toBe(true);
      },
      { timeout: 5000 },
    );

    const uploadCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/products/product-3/variants/0/image',
    );
    const formData = (uploadCall?.[1] as RequestInit).body as FormData;
    const uploaded = formData.get('image');
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).name).toBe('variant.png');
  });

  it('guides a seller to categories when no category exists yet', async () => {
    const user = userEvent.setup();
    installedFetch((url) => {
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: [], nextCursor: null } });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [] });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();
    await screen.findByText('No products yet');

    await user.click(screen.getAllByRole('button', { name: /add product/i })[0]);
    const addDialog = await screen.findByRole('dialog', { name: 'Add product' });
    expect(
      within(addDialog).getByText(
        'A product needs a category. Create one before saving this product.',
      ),
    ).toBeVisible();

    await user.click(within(addDialog).getByRole('button', { name: 'Manage categories' }));
    const categoryDialog = await screen.findByRole('dialog', { name: 'Categories' });
    expect(within(categoryDialog).getByText('No categories yet')).toBeVisible();
  });

  it('creates a category from the category sheet', async () => {
    const user = userEvent.setup();
    let categories: CategoryDto[] = [];
    installedFetch((url, init) => {
      if (url === '/api/categories' && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body)) as { name: string };
        const created: CategoryDto = {
          ...category,
          id: 'cat-2',
          name: payload.name,
          version: 1,
        };
        categories = [created];
        return jsonResponse(201, { success: true, data: created });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: categories });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: [], nextCursor: null } });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();
    await screen.findByText('No products yet');

    await user.click(screen.getByRole('button', { name: 'Categories' }));
    const dialog = await screen.findByRole('dialog', { name: 'Categories' });

    await user.type(within(dialog).getByLabelText('Category name'), 'Shoes');
    await user.click(within(dialog).getByRole('button', { name: 'Create category' }));

    expect(await within(dialog).findByText('Shoes')).toBeVisible();
    expect(within(dialog).getByLabelText('Category name')).toHaveValue('');
  });

  it('masks a category server error behind a generic message', async () => {
    const user = userEvent.setup();
    installedFetch((url, init) => {
      if (url === '/api/categories' && init?.method === 'POST') {
        return jsonResponse(500, {
          error: 'INTERNAL_ERROR',
          message: 'relation "categories" does not exist',
        });
      }
      if (url === '/api/categories') {
        return jsonResponse(200, { success: true, data: [] });
      }
      if (url.startsWith('/api/products?')) {
        return jsonResponse(200, { success: true, data: { items: [], nextCursor: null } });
      }
      if (url === '/api/business/me') {
        return jsonResponse(200, { success: true, data: { currency: 'BDT' } });
      }
      return undefined;
    });

    renderPage();
    await screen.findByText('No products yet');

    await user.click(screen.getByRole('button', { name: 'Categories' }));
    const dialog = await screen.findByRole('dialog', { name: 'Categories' });
    await user.type(within(dialog).getByLabelText('Category name'), 'Shoes');
    await user.click(within(dialog).getByRole('button', { name: 'Create category' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The server could not complete the request. Try again.',
    );
    expect(within(dialog).queryByText(/relation/)).not.toBeInTheDocument();
  });
});
