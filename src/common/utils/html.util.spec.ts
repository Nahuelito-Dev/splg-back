import { escaparHtml } from './html.util';

describe('escaparHtml', () => {
  it('neutraliza las etiquetas y las comillas', () => {
    expect(escaparHtml(`<img src=x onerror="a('b')">&`)).toBe(
      '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;',
    );
  });

  it('deja el texto común como está', () => {
    expect(escaparHtml('Ana Pérez')).toBe('Ana Pérez');
  });
});
