import { BadRequestException, Injectable } from '@nestjs/common';
import { WpsFormat } from '../types/wps-format.interface';
import { OmanCboFormat } from './oman-cbo.format';
import { OmanSifEdrFormat } from './oman-sif-edr.format';
import { GenericCsvFormat } from './generic-csv.format';

/**
 * The wage-file formats this deployment can produce.
 *
 * To add a country: implement WpsFormat, then add one line to the constructor
 * below. Nothing else in the codebase changes — the settings form, the pre-flight,
 * the generator and the download route are all format-agnostic.
 */
@Injectable()
export class WpsFormatRegistry {
  private readonly formats = new Map<string, WpsFormat>();

  constructor(
    private readonly omanCbo: OmanCboFormat,
    private readonly omanSifEdr: OmanSifEdrFormat,
    private readonly genericCsv: GenericCsvFormat,
  ) {
    this.register(this.omanCbo);
    this.register(this.omanSifEdr);
    this.register(this.genericCsv);
  }

  private register(format: WpsFormat): void {
    if (this.formats.has(format.key)) {
      throw new Error(`Duplicate WPS format key: ${format.key}`);
    }
    this.formats.set(format.key, format);
  }

  /** Test seam: lets an e2e suite plug in a fake format without a bank spec. */
  registerForTesting(format: WpsFormat): void {
    this.formats.set(format.key, format);
  }

  list(): WpsFormat[] {
    return [...this.formats.values()];
  }

  /**
   * Formats applicable to a country. The generic CSV is offered everywhere: it is
   * not a legal submission format, but it makes the whole flow exercisable in a
   * market whose real layout has not been implemented yet.
   */
  listForCountry(iso2: string): WpsFormat[] {
    const cc = (iso2 || '').toUpperCase();
    return this.list().filter((f) => f.country === cc || f.country === '*');
  }

  has(key: string): boolean {
    return this.formats.has(key);
  }

  get(key: string): WpsFormat {
    const format = this.formats.get(key);
    if (!format) {
      throw new BadRequestException(
        `Unknown WPS format '${key}'. Available: ${[...this.formats.keys()].join(', ')}`,
      );
    }
    return format;
  }
}
