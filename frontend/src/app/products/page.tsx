'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { FolderTree, Package, Plus, Search, X } from 'lucide-react';
import type {
  CategoryDto,
  ProductDto,
  ProductPageDto,
  ProductStockStatus,
} from '@f-commerce/contracts';
import { ProductCreateSchema } from '@f-commerce/contracts';
import { AppShell } from '@/components/shell/shell';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  Input,
  RecordCard,
  Select,
  Sheet,
  Skeleton,
} from '@/components/ui/primitives';
import { CategoryManager } from '@/components/catalog/category-manager';
import { ProductFields } from '@/components/catalog/product-form';
import { StockBadge } from '@/components/catalog/stock-badge';
import { useBusinessSettings } from '@/components/business/business-settings-provider';
import { isTimeoutError } from '@/lib/auth-client';
import { useRequireAuth } from '@/lib/auth-guard';
import {
  CatalogApiError,
  createProduct,
  listCategories,
  listProducts,
  uploadProductImages,
  uploadVariantImage,
} from '@/lib/catalog-client';
import {
  catalogMessage,
  duplicateSkuFromError,
  fieldErrorsFromIssues,
  fieldErrorsFromServer,
  type DuplicateSkuNotice,
} from '@/lib/catalog-errors';
import { formatMoney } from '@/lib/catalog-format';
import {
  MAX_PRODUCT_IMAGES,
  buildCombinations,
  emptyProductForm,
  toCreateInput,
  validateImageFile,
  type OptionDraft,
  type ProductFormState,
  type VariantDraft,
} from '@/lib/catalog-form';

const PAGE_SIZE = 20;

type StockFilter = '' | ProductStockStatus;

interface Notice {
  message: string;
  href?: string;
}

function ProductThumbnail({ product }: { product: ProductDto }) {
  const image = product.images[0];
  if (!image) {
    return (
      <span
        aria-hidden="true"
        className="grid size-12 shrink-0 place-items-center rounded-md border border-dashed border-border bg-surface-muted text-muted"
      >
        <Package size={18} />
      </span>
    );
  }

  return (
    <Image
      alt={`${product.name} image`}
      className="size-12 shrink-0 rounded-md border border-border object-cover"
      height={48}
      src={image}
      unoptimized
      width={48}
    />
  );
}

function ProductNameCell({ product }: { product: ProductDto }) {
  return (
    <div className="flex items-center gap-3">
      <ProductThumbnail product={product} />
      <div className="grid gap-1">
        <Link
          className="font-semibold text-ink hover:text-sky-strong"
          href={`/products/${product.id}`}
        >
          {product.name}
        </Link>
        <span className="font-mono text-xs text-muted">{product.sku ?? 'No SKU'}</span>
      </div>
    </div>
  );
}

export default function ProductsPage() {
  const ready = useRequireAuth();
  const { currency } = useBusinessSettings();

  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [stockStatus, setStockStatus] = useState<StockFilter>('');
  const [includeArchived, setIncludeArchived] = useState(false);

  const [page, setPage] = useState<ProductPageDto>({ items: [], nextCursor: null });
  // Cursors that produced each visited page, so Previous refetches instead of
  // replaying a stale snapshot.
  const [cursorStack, setCursorStack] = useState<(string | undefined)[]>([undefined]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<ProductFormState>(emptyProductForm());
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [variants, setVariants] = useState<VariantDraft[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateSkuNotice | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Load the first page whenever a filter settles. Cancellation keeps a slow
  // response from replacing a newer query.
  useEffect(() => {
    let cancelled = false;

    listProducts({
      q: debouncedQuery,
      categoryId: categoryId === '' ? undefined : categoryId,
      stockStatus: stockStatus === '' ? undefined : stockStatus,
      includeArchived,
      limit: PAGE_SIZE,
    })
      .then((next) => {
        if (cancelled) return;
        setPage(next);
        setCursorStack([undefined]);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(catalogMessage(err));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, categoryId, stockStatus, includeArchived, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    listCategories()
      .then((next) => {
        if (!cancelled) {
          setCategories(next);
          setCategoryError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setCategoryError(catalogMessage(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const refreshCategories = useCallback(async () => {
    try {
      const next = await listCategories();
      setCategories(next);
      setCategoryError(null);
    } catch (err) {
      setCategoryError(catalogMessage(err));
    }
  }, []);

  const refreshAfterCategoryChange = useCallback(async () => {
    try {
      const next = await listCategories();
      setCategories(next);
      setCategoryError(null);
      // A deleted category must not stay selected, or the next product query
      // would fail with a category validation error.
      setCategoryId((current) =>
        current !== '' && !next.some((category) => category.id === current) ? '' : current,
      );
    } catch (err) {
      setCategoryError(catalogMessage(err));
    }
    setReloadToken((current) => current + 1);
  }, []);

  const retry = () => {
    setIsLoading(true);
    setError(null);
    setReloadToken((current) => current + 1);
  };

  const goToNext = async () => {
    if (!page.nextCursor || isLoading) return;

    const cursor = page.nextCursor;
    setIsLoading(true);
    setError(null);
    try {
      const next = await listProducts({
        q: debouncedQuery,
        categoryId: categoryId === '' ? undefined : categoryId,
        stockStatus: stockStatus === '' ? undefined : stockStatus,
        includeArchived,
        limit: PAGE_SIZE,
        cursor,
      });
      setPage(next);
      setCursorStack((current) => [...current, cursor]);
    } catch (err) {
      setError(catalogMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const goToPrevious = async () => {
    if (cursorStack.length <= 1 || isLoading) return;

    const nextStack = cursorStack.slice(0, -1);
    const cursor = nextStack[nextStack.length - 1];
    setIsLoading(true);
    setError(null);
    try {
      const previous = await listProducts({
        q: debouncedQuery,
        categoryId: categoryId === '' ? undefined : categoryId,
        stockStatus: stockStatus === '' ? undefined : stockStatus,
        includeArchived,
        limit: PAGE_SIZE,
        cursor,
      });
      setPage(previous);
      setCursorStack(nextStack);
    } catch (err) {
      setError(catalogMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const filtersActive =
    debouncedQuery.trim() !== '' || categoryId !== '' || stockStatus !== '' || includeArchived;

  const clearFilters = () => {
    if (!filtersActive) return;
    setIsLoading(true);
    setQuery('');
    setDebouncedQuery('');
    setCategoryId('');
    setStockStatus('');
    setIncludeArchived(false);
  };

  const openCreate = () => {
    setForm(emptyProductForm(categoryId !== '' ? categoryId : (categories[0]?.id ?? '')));
    setOptions([]);
    setVariants([]);
    setFieldErrors({});
    setFormError(null);
    setDuplicate(null);
    setImageFiles([]);
    setImageError(null);
    setFormOpen(true);
  };

  const closeCreate = () => {
    setFormOpen(false);
    setFieldErrors({});
    setFormError(null);
    setDuplicate(null);
    setImageFiles([]);
    setImageError(null);
  };

  const addImages = async (selected: File[]) => {
    setImageError(null);
    if (selected.length === 0) return;
    if (selected.length > MAX_PRODUCT_IMAGES) {
      setImageError(`Choose at most ${MAX_PRODUCT_IMAGES} images.`);
      return;
    }

    const errors: string[] = [];
    for (const file of selected) {
      const error = await validateImageFile(file);
      if (error !== null) errors.push(`${file.name}: ${error}`);
    }

    if (errors.length > 0) {
      setImageError(errors.join(' '));
      return;
    }

    setImageFiles(selected);
  };

  const submitCreate = async () => {
    const required: Record<string, string> = {};
    if (form.name.trim() === '') required.name = 'Enter a product name.';
    if (form.categoryId === '') required.categoryId = 'Choose a category.';
    if (form.price.trim() === '') required.price = 'Enter a price.';
    if (Object.keys(required).length > 0) {
      setFieldErrors(required);
      setFormError('Check the highlighted fields.');
      return;
    }

    const matrix = buildCombinations(options);
    if (matrix.error !== null) {
      setFieldErrors({ options: matrix.error });
      setFormError('Fix the option matrix before saving.');
      return;
    }

    const parsed = ProductCreateSchema.safeParse(toCreateInput(form, options, variants));
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromIssues(parsed.error.issues));
      setFormError('Check the highlighted fields.');
      return;
    }

    setIsSaving(true);
    setFormError(null);
    setDuplicate(null);

    try {
      const created = await createProduct(parsed.data);
      let imageFailures = 0;
      let uploadTimedOut = false;

      if (imageFiles.length > 0) {
        try {
          await uploadProductImages(created.id, imageFiles);
        } catch (uploadError) {
          imageFailures += 1;
          uploadTimedOut = uploadTimedOut || isTimeoutError(uploadError);
        }
      }

      // Variant images need the product's variant positions, so they are
      // uploaded after the create request. Each successful upload bumps the
      // product version; the form has no stale version to conflict with.
      for (let index = 0; index < variants.length; index += 1) {
        const file = variants[index].imageFile;
        if (!file) continue;
        try {
          await uploadVariantImage(created.id, index, file);
        } catch (uploadError) {
          imageFailures += 1;
          uploadTimedOut = uploadTimedOut || isTimeoutError(uploadError);
        }
      }

      setFormOpen(false);
      if (imageFailures > 0) {
        const count = imageFailures === 1 ? 'an image' : `${imageFailures} images`;
        setNotice({
          message: `${created.name} was added, but ${count} could not be uploaded${
            uploadTimedOut ? ' before the upload timed out' : ''
          }. Open it to add them.`,
          href: `/products/${created.id}`,
        });
      } else {
        setNotice({ message: `${created.name} was added` });
      }
      setIsLoading(true);
      setReloadToken((current) => current + 1);
    } catch (err) {
      const duplicateNotice = duplicateSkuFromError(err);
      if (duplicateNotice !== null) {
        setDuplicate(duplicateNotice);
      } else if (err instanceof CatalogApiError && err.status === 400) {
        setFieldErrors(fieldErrorsFromServer(err.fields));
      }

      if (isTimeoutError(err)) {
        setFormError(
          'The request timed out. The product may have been created. Close this form and reload the catalog before trying again.',
        );
      } else {
        setFormError(catalogMessage(err));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const columns = [
    {
      key: 'name' as const,
      label: 'Product',
      render: (row: ProductDto) => <ProductNameCell product={row} />,
    },
    {
      key: 'categoryName' as const,
      label: 'Category',
      render: (row: ProductDto) => <span className="text-body">{row.categoryName ?? '—'}</span>,
    },
    {
      key: 'price' as const,
      label: 'Price',
      render: (row: ProductDto) => (
        <span className="font-mono text-body">{formatMoney(row.price, currency)}</span>
      ),
    },
    {
      key: 'availableStock' as const,
      label: 'Stock',
      render: (row: ProductDto) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-body">{row.availableStock}</span>
          <StockBadge status={row.stockStatus} />
        </div>
      ),
    },
    {
      key: 'variants' as const,
      label: 'Variants',
      render: (row: ProductDto) => (
        <span className="text-body">
          {row.variants.length === 0 ? 'Single' : `${row.variants.length}`}
        </span>
      ),
    },
    {
      key: 'version' as const,
      label: 'State',
      render: (row: ProductDto) =>
        row.isArchived ? (
          <span className="text-sm font-semibold text-muted">Archived</span>
        ) : (
          <span className="text-sm text-body">Live</span>
        ),
    },
  ];

  const rows = page.items;
  const pageNumber = Math.max(cursorStack.length, 1);

  if (!ready) {
    return (
      <AppShell>
        <Skeleton className="h-64 w-full" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="grid gap-8">
        <header className="grid gap-4 lg:flex lg:items-end lg:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-sky-strong">Catalog</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Products</h1>
            <p className="mt-2 max-w-xl text-base leading-7 text-body">
              Keep prices, stock, variants, and images in one place. Archive a product to hide it
              without deleting its history.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={() => {
                setFormOpen(false);
                setCategoryOpen(true);
              }}
              type="button"
              variant="secondary"
            >
              <FolderTree aria-hidden="true" size={18} />
              Categories
            </Button>
            <Button onClick={openCreate} type="button">
              <Plus aria-hidden="true" size={18} />
              Add product
            </Button>
          </div>
        </header>

        {notice && (
          <Alert variant="success">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{notice.message}</span>
              <span className="flex flex-wrap items-center gap-2">
                {notice.href && (
                  <Link
                    className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
                    href={notice.href}
                  >
                    Open product
                  </Link>
                )}
                <Button onClick={() => setNotice(null)} type="button" variant="quiet">
                  Dismiss
                </Button>
              </span>
            </div>
          </Alert>
        )}

        {categoryError && (
          <Alert variant="danger">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>Categories could not be loaded. {categoryError}</span>
              <Button onClick={() => void refreshCategories()} type="button" variant="secondary">
                Try again
              </Button>
            </div>
          </Alert>
        )}

        <section aria-labelledby="product-filters-title" className="grid gap-4">
          <h2 className="sr-only" id="product-filters-title">
            Find products
          </h2>

          <FilterBar>
            <div className="min-w-0 flex-1">
              <Field htmlFor="product-search" label="Search by name or SKU">
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted"
                    size={18}
                  />
                  <Input
                    autoComplete="off"
                    className="pl-10"
                    id="product-search"
                    onChange={(event) => {
                      setIsLoading(true);
                      setQuery(event.target.value);
                    }}
                    placeholder="e.g. Oxford or SHIRT-1"
                    type="search"
                    value={query}
                  />
                </div>
              </Field>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 md:w-auto md:grid-cols-none md:flex md:items-end">
              <div className="md:w-48">
                <Field htmlFor="product-filter-category" label="Category">
                  <Select
                    id="product-filter-category"
                    onChange={(event) => {
                      setIsLoading(true);
                      setCategoryId(event.target.value);
                    }}
                    value={categoryId}
                  >
                    <option value="">All categories</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="md:w-40">
                <Field htmlFor="product-filter-stock" label="Stock">
                  <Select
                    id="product-filter-stock"
                    onChange={(event) => {
                      setIsLoading(true);
                      setStockStatus(event.target.value as StockFilter);
                    }}
                    value={stockStatus}
                  >
                    <option value="">Any stock</option>
                    <option value="inStock">In stock</option>
                    <option value="lowStock">Low stock</option>
                    <option value="outOfStock">Out of stock</option>
                  </Select>
                </Field>
              </div>

              <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-ink">
                <input
                  checked={includeArchived}
                  className="size-5 rounded border-border accent-sky focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky"
                  id="product-filter-archived"
                  onChange={(event) => {
                    setIsLoading(true);
                    setIncludeArchived(event.target.checked);
                  }}
                  type="checkbox"
                />
                Include archived
              </label>
            </div>

            {filtersActive && (
              <Button onClick={clearFilters} type="button" variant="quiet">
                <X aria-hidden="true" size={16} />
                Clear filters
              </Button>
            )}
          </FilterBar>
        </section>

        {isLoading && rows.length === 0 && (
          <div className="grid gap-3" role="status">
            <span className="sr-only">Loading products…</span>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}

        {error && <ErrorState onRetry={retry}>{error}</ErrorState>}

        {!isLoading && !error && rows.length === 0 && (
          <div role="status">
            <EmptyState>
              <div>
                <Package aria-hidden="true" className="mx-auto mb-3 text-muted" size={28} />
                {filtersActive ? (
                  <>
                    <p className="font-semibold text-ink">No products match these filters</p>
                    <p className="mt-1 text-sm text-body">
                      Try another search, or clear a filter to see the whole catalog.
                    </p>
                    <Button
                      className="mt-4"
                      onClick={clearFilters}
                      type="button"
                      variant="secondary"
                    >
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="font-semibold text-ink">No products yet</p>
                    <p className="mt-1 text-sm text-body">
                      {categories.length === 0
                        ? 'Create a category first, then add your first product.'
                        : 'Add your first product to track stock, variants, and prices.'}
                    </p>
                    <Button
                      className="mt-4"
                      onClick={() => {
                        if (categories.length === 0) {
                          setCategoryOpen(true);
                        } else {
                          openCreate();
                        }
                      }}
                      type="button"
                    >
                      <Plus aria-hidden="true" size={18} />
                      {categories.length === 0 ? 'Manage categories' : 'Add product'}
                    </Button>
                  </>
                )}
              </div>
            </EmptyState>
          </div>
        )}

        {rows.length > 0 && (
          <Card className="overflow-hidden p-0">
            <DataTable columns={columns} rows={rows} />
            <div className="grid gap-3 p-4 md:hidden">
              {rows.map((row) => (
                <RecordCard key={row.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <ProductThumbnail product={row} />
                      <div className="min-w-0">
                        <Link
                          className="text-lg font-semibold text-ink hover:text-sky-strong"
                          href={`/products/${row.id}`}
                        >
                          {row.name}
                        </Link>
                        <p className="mt-1 font-mono text-xs text-muted">
                          {row.sku ?? 'No SKU'} · {row.categoryName ?? 'No category'}
                        </p>
                      </div>
                    </div>
                    <StockBadge status={row.stockStatus} />
                  </div>
                  <div className="grid grid-cols-3 gap-3 border-t border-border pt-3 text-sm">
                    <div>
                      <p className="text-muted">Price</p>
                      <p className="mt-1 font-mono text-ink">{formatMoney(row.price, currency)}</p>
                    </div>
                    <div>
                      <p className="text-muted">Stock</p>
                      <p className="mt-1 font-mono text-ink">{row.availableStock}</p>
                    </div>
                    <div>
                      <p className="text-muted">Variants</p>
                      <p className="mt-1 text-ink">
                        {row.variants.length === 0 ? 'Single' : row.variants.length}
                      </p>
                    </div>
                  </div>
                  {row.isArchived && (
                    <p className="border-t border-border pt-3 text-sm font-semibold text-muted">
                      Archived
                    </p>
                  )}
                </RecordCard>
              ))}
            </div>
          </Card>
        )}

        {rows.length > 0 && (
          <nav
            aria-label="Product pages"
            className="flex items-center justify-between border-t border-border pt-4"
          >
            <Button
              disabled={cursorStack.length <= 1 || isLoading}
              onClick={goToPrevious}
              type="button"
              variant="secondary"
            >
              Previous
            </Button>
            <span className="font-mono text-sm text-muted">Page {pageNumber}</span>
            <Button
              disabled={!page.nextCursor || isLoading}
              onClick={() => void goToNext()}
              type="button"
              variant="secondary"
            >
              Next
            </Button>
          </nav>
        )}
      </div>

      <Sheet onClose={closeCreate} open={formOpen} title="Add product">
        <form
          className="grid gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            void submitCreate();
          }}
        >
          {categories.length === 0 && (
            <Alert variant="neutral">
              <div className="grid gap-3">
                <p>A product needs a category. Create one before saving this product.</p>
                <Button
                  onClick={() => {
                    closeCreate();
                    setCategoryOpen(true);
                  }}
                  type="button"
                  variant="secondary"
                >
                  Manage categories
                </Button>
              </div>
            </Alert>
          )}

          {formError && <Alert variant="danger">{formError}</Alert>}

          {duplicate && (
            <Alert variant="danger">
              <div className="grid gap-3">
                <p className="font-semibold text-ink">
                  {duplicate.archived
                    ? 'That SKU belongs to an archived product'
                    : 'That SKU is already in use'}
                </p>
                <p>{duplicate.message}</p>
                <Link
                  className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
                  href={`/products/${duplicate.existingProductId}`}
                >
                  Open the existing product
                </Link>
                {duplicate.archived && (
                  <p className="text-sm">
                    Restore that product before reusing its SKU, or choose a different SKU.
                  </p>
                )}
              </div>
            </Alert>
          )}

          <ProductFields
            categories={categories}
            disabled={isSaving}
            fieldErrors={fieldErrors}
            form={form}
            idPrefix="new-product"
            mode="create"
            onFormChange={setForm}
            onOptionsChange={setOptions}
            onVariantsChange={setVariants}
            options={options}
            variants={variants}
          />

          <section aria-labelledby="new-product-images-title" className="grid gap-3">
            <div>
              <h3 className="text-lg font-semibold text-ink" id="new-product-images-title">
                Images
              </h3>
              <p className="mt-1 text-sm text-body">
                JPG, PNG, or WebP. Up to {MAX_PRODUCT_IMAGES} images, 2 MB each.
              </p>
            </div>

            {imageError && <Alert variant="danger">{imageError}</Alert>}

            <Field htmlFor="new-product-images" label="Add images">
              <Input
                accept="image/jpeg,image/png,image/webp"
                disabled={isSaving}
                id="new-product-images"
                multiple
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []);
                  event.target.value = '';
                  void addImages(selected);
                }}
                type="file"
              />
            </Field>

            {imageFiles.length > 0 && (
              <ul className="grid gap-2 rounded-md border border-border p-3">
                {imageFiles.map((file, index) => (
                  <li className="flex items-center justify-between gap-3 text-sm" key={file.name}>
                    <span className="truncate text-body">{file.name}</span>
                    <Button
                      onClick={() =>
                        setImageFiles((current) => current.filter((_, item) => item !== index))
                      }
                      type="button"
                      variant="quiet"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="flex flex-wrap gap-3">
            <Button disabled={isSaving || categories.length === 0} type="submit">
              {isSaving ? 'Saving…' : 'Save product'}
            </Button>
            <Button onClick={closeCreate} type="button" variant="secondary">
              Cancel
            </Button>
          </div>
        </form>
      </Sheet>

      {categoryOpen && (
        <CategoryManager
          categories={categories}
          onClose={() => setCategoryOpen(false)}
          onNotice={(message) => setNotice({ message })}
          onRefresh={refreshAfterCategoryChange}
        />
      )}
    </AppShell>
  );
}
