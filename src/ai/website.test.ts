// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  extractWebsiteRecipes,
  importRecipeWebsite,
  isPublicAddress,
  plainRecipeText,
  validateRecipeUrl,
} from '../../server/src/website';
import { createWorker } from '../../server/src/index';

const recipe = {
  '@type': 'Recipe',
  name: 'Eggs &amp; toast',
  recipeYield: '2 servings',
  recipeIngredient: ['2 eggs', '1 tbsp olive oil'],
  recipeInstructions: [
    {
      '@type': 'HowToSection',
      name: 'Cook',
      itemListElement: [
        { '@type': 'HowToStep', text: '<p>Heat the pan.</p>' },
        { '@type': 'HowToStep', text: 'Cook the eggs.' },
      ],
    },
  ],
};
const html = (value: unknown) =>
  `<html><script type="application/ld+json">${JSON.stringify(value)}</script></html>`;
const dns = () =>
  new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }));
const site = (value = recipe) =>
  new Response(html(value), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

describe('recipe website import', () => {
  it('finds Recipe nodes inside arrays and @graph and flattens instruction sections', () => {
    const result = extractWebsiteRecipes(
      html([{ '@type': 'WebSite' }, { '@graph': [{ '@type': 'Person' }, recipe] }]),
    );
    expect(result.recipes).toHaveLength(1);
    expect(result.recipes[0]).toMatchObject({
      title: 'Eggs & toast',
      servings: 2,
      steps: ['Heat the pan.', 'Cook the eggs.'],
      ingredients: [
        { name: 'eggs', quantity: 2, unit: 'each' },
        { name: 'olive oil', quantity: 1, unit: 'tbsp' },
      ],
    });
  });

  it('sanitizes markup and encoded text without executing HTML or scripts', () => {
    expect(plainRecipeText('<p>Mix &amp; fry.</p><script>alert(1)</script>')).toBe('Mix & fry.');
    expect(plainRecipeText('&lt;strong&gt;Eggs&lt;/strong&gt;')).toBe('Eggs');
  });

  it('preserves unknown amounts and ambiguous yields for review', () => {
    const result = extractWebsiteRecipes(
      html({
        ...recipe,
        recipeYield: '12 cookies',
        recipeIngredient: ['salt to taste', '2 (14 oz) cans tomatoes', '1 large onion'],
      }),
    );
    expect(result.recipes[0].servings).toBeNull();
    expect(result.recipes[0].ingredients.every((ingredient) => ingredient.quantity === null)).toBe(
      true,
    );
    expect(result.warnings).toHaveLength(2);
  });

  it('accepts explicit serving yields but does not turn an unlabeled yield into servings', () => {
    expect(
      extractWebsiteRecipes(html({ ...recipe, recipeYield: ['12 cookies', 'Serves 4'] })).recipes[0]
        .servings,
    ).toBe(4);
    expect(
      extractWebsiteRecipes(html({ ...recipe, recipeYield: '4' })).recipes[0].servings,
    ).toBeNull();
  });

  it('ignores unrelated/malformed scripts and requires actual ingredients plus steps', () => {
    expect(() => extractWebsiteRecipes('<script>{"@type":"Recipe"}</script>')).toThrow(
      'complete readable recipe',
    );
    expect(() => extractWebsiteRecipes(html({ ...recipe, recipeInstructions: [] }))).toThrow(
      'complete readable recipe',
    );
    expect(() =>
      extractWebsiteRecipes('<script type="application/ld+json">not json</script>'),
    ).toThrow('complete readable recipe');
  });

  it('rejects unsafe schemes, addresses, credentials, ports and Worker recursion', () => {
    for (const url of [
      'http://recipes.example.com/r',
      'https://localhost/r',
      'https://foo.local/r',
      'https://127.0.0.1/r',
      'https://2130706433/r',
      'https://[::1]/r',
      'https://user:secret@recipes.example.com/r',
      'https://recipes.example.com:8443/r',
      'https://mise.example.workers.dev/chat',
      'https://127-0-0-1.nip.io/r',
    ])
      expect(() => validateRecipeUrl(url)).toThrow();
    expect(validateRecipeUrl('https://recipes.example.com/r#recipe').href).toBe(
      'https://recipes.example.com/r',
    );
  });

  it('rejects nonpublic IPv4/IPv6 DNS results', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      '::ffff:127.0.0.1',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '2002:7f00:1::',
    ])
      expect(isPublicAddress(address)).toBe(false);
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2001:4860:4860::8888')).toBe(true);
  });

  it('imports website JSON-LD without calling Gemini or forwarding credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).startsWith('https://cloudflare-dns.com/') ? dns() : site(),
      );
    const result = await importRecipeWebsite('https://recipes.example.com/r', fetcher);
    expect(result.recipes[0].title).toBe('Eggs & toast');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('generativelanguage'))).toBe(
      false,
    );
    const options = fetcher.mock.calls[2][1];
    expect(options?.redirect).toBe('manual');
    expect(options?.headers).not.toHaveProperty('Authorization');
    expect(options?.headers).not.toHaveProperty('Cookie');
  });

  it('blocks private DNS before contacting the recipe site', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '10.0.0.1' }] })),
      );
    await expect(
      importRecipeWebsite('https://recipes.example.com/r', fetcher),
    ).rejects.toMatchObject({ code: 'import_url' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('revalidates every redirect, rejecting a private address rather than following it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).startsWith('https://cloudflare-dns.com/')
        ? dns()
        : new Response(null, {
            status: 302,
            headers: { Location: 'https://169.254.169.254/latest/meta-data' },
          }),
    );
    await expect(
      importRecipeWebsite('https://recipes.example.com/r', fetcher),
    ).rejects.toMatchObject({ code: 'import_url' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('follows a bounded public relative redirect and checks its destination again', async () => {
    let pages = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).startsWith('https://cloudflare-dns.com/')) return dns();
      pages++;
      return pages === 1
        ? new Response(null, { status: 302, headers: { Location: '/final' } })
        : site();
    });
    expect(
      (await importRecipeWebsite('https://recipes.example.com/r', fetcher)).recipes,
    ).toHaveLength(1);
    expect(fetcher.mock.calls[5][0]).toBe('https://recipes.example.com/final');
  });

  it('limits downloaded page size and rejects blocked/non-HTML responses', async () => {
    for (const response of [
      new Response('blocked', { status: 403 }),
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
      new Response('tiny', {
        headers: { 'Content-Type': 'text/html', 'Content-Length': String(3 * 1024 * 1024) },
      }),
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).startsWith('https://cloudflare-dns.com/') ? dns() : response,
        );
      await expect(importRecipeWebsite('https://recipes.example.com/r', fetcher)).rejects.toThrow();
    }
  });

  it('keeps the import endpoint authenticated before DNS or website work', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await createWorker(fetcher).fetch(
      new Request('https://mise.example.workers.dev/import', {
        method: 'POST',
        headers: { Origin: 'https://mise.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://recipes.example.com/r' }),
      }),
      {
        ALLOWED_ORIGIN: 'https://mise.example.com',
        GEMINI_API_KEY: 'test-only-placeholder',
        MISE_ACCESS_TOKEN: 'a'.repeat(40),
      },
    );
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
