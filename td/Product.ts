// Translated from Models/{Product,Price,Notification,Supplier,Warehouse}.cs
//
// The C# version kept two representations of the same data in sync by hand:
// domain fields marked [NotMapped] (Price, Discounts, Images, SuppliersRegions,
// Warehouse) plus flattened EF columns (PriceAmount/DiscountsCsv/ImagesJson/...),
// reconciled via SyncEfColumns()/HydrateFromEfColumns(). Prisma maps Decimal,
// String[] and Json columns natively (see schema.prisma), so that flattening
// and the two sync methods are gone: PrismaClient reads/writes plain objects
// and there is exactly one representation of each field.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

export type Channel = "email" | "sms" | "push";
export type Status = "active" | "out_of_stock" | "deprecated";

export interface Notification {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  channel: Channel;
  sentAt: Date;
  productId?: string;
}

export class Supplier {
  constructor(
    public id: string,
    public name: string,
    public email: string,
    public region: string,
  ) { }
}

export class Warehouse {
  constructor(
    public id: string,
    public name: string,
    public address: string,
    public region: string,
  ) { }
}

export const DEFAULT_MARGIN_PERCENTAGE: number = 15;
export const DEFAULT_VAT_PERCENTAGE: number = 20;

export class Price {
  amount: number;
  currency: string;
  margin: number; // percentage
  vat: number; // percentage, applied on margin only

  constructor(amount: number, currency: string) {
    this.amount = amount;
    this.currency = currency;
    this.margin = DEFAULT_MARGIN_PERCENTAGE;
    this.vat = DEFAULT_VAT_PERCENTAGE;
  }

  getResellerPrice(): number {
    const marginAmount = (this.amount * this.margin) / 100;
    const vatAmount = (marginAmount * this.vat) / 100;
    return this.amount + marginAmount + vatAmount;
  }

  getAmount(): number {
    return this.amount;
  }

  setAmount(amount: number): void {
    this.amount = amount;
  }

  getCurrency(): string {
    return this.currency;
  }

  setCurrency(currency: string): void {
    this.currency = currency;
  }

  getMargin(): number {
    return this.margin;
  }

  setMargin(margin: number): void {
    this.margin = margin;
  }
}

export class Product {
  id: string;
  name: string;
  slug: string;
  price: Price;
  discounts: string[];
  images: Record<string, string>; // key = context ("thumbnail", "hero", ...), value = url
  suppliersRegions: Map<string, Supplier>; // key = region
  weight: number;
  dimensions: string;
  quantity: number;
  stock: number;
  warehouse: Warehouse | null;
  status: Status;
  createdAt: Date;
  updatedAt: Date;
  notifications: Notification[] = [];
  validUntil: Date | null = null;

  constructor(
    id: string,
    name: string,
    slug: string,
    price: Price,
    discounts: string[],
    images: Record<string, string>,
    suppliersRegions: Map<string, Supplier>,
    weight: number,
    dimensions: string,
    quantity: number,
    stock: number,
    warehouse: Warehouse | null,
  ) {
    this.id = id;
    this.name = name;
    this.slug = slug;
    this.price = price;
    this.discounts = discounts;
    this.images = images;
    this.suppliersRegions = suppliersRegions;
    this.weight = weight;
    this.dimensions = dimensions;
    this.quantity = quantity;
    this.stock = stock;
    this.warehouse = warehouse;
    this.status = "active";
    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  getDisplayLabel(): string {
    if (this.status === "deprecated") {
      return `[DISCONTINUED] ${this.name}`;
    }

    if (this.stock === 0) {
      return `[OUT OF STOCK] ${this.name}`;
    }

    return this.name;
  }

  // --- Catalog / images / discounts ---

  async addImage(context: string, url: string): Promise<void> {
    if (url) {
      if (url.substring(0, 4) === "http") {
        if (!(this.images[context] === undefined)) {
          let imageKey = context;
          for (const [, supplier] of this.suppliersRegions) {
            if (supplier.region) {
              if (supplier.email) {
                if (supplier.email.indexOf("@") > 0 && supplier.email.indexOf(".", supplier.email.indexOf("@")) > supplier.email.indexOf("@")) {
                  imageKey = context + "-" + supplier.name;
                } else {
                  throw new Error(`Supplier ${supplier.name} has a malformed email: ${supplier.email}`);
                }
              } else {
                imageKey = context + "-supplier";
              }
            } else {
              imageKey = this.warehouse ? context + "-" + this.warehouse.name : context;
            }
          }
          this.images[imageKey] = url;
        } else {
          this.images[context] = url;
        }
        this.updatedAt = new Date();
        await prisma.product.update({
          where: { id: this.id },
          data: { images: this.images as Prisma.InputJsonValue, updatedAt: this.updatedAt },
        });
      } else {
        throw new Error("url must start with http");
      }
    } else {
      throw new Error("url must start with http");
    }
  }

  getValidUntil(): Date | null {
    return this.validUntil;
  }

  setValidUntil(validUntil: Date | null): void {
    this.validUntil = validUntil;
  }

  async addDiscount(discountCode: string, validUntil: Date): Promise<void> {
    if (!discountCode) {
      throw new Error("discountCode is required");
    }

    if (validUntil < new Date()) {
      throw new Error("validUntil cannot be in the past");
    }

    if (this.discounts.length >= 2) {
      throw new Error("Cannot have more than 2 discounts at the same time");
    }

    this.discounts.push(discountCode);
    this.setValidUntil(validUntil);
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { discounts: this.discounts, updatedAt: this.updatedAt },
    });
  }

  // --- Suppliers ---

  async addSupplierToRegion(region: string, suppliers: Supplier[]): Promise<void> {
    const supplier = suppliers.find((candidateSupplier) => candidateSupplier.region === region);
    if (!supplier) throw new Error(`No supplier found for region ${region}`);

    this.suppliersRegions.set(region, supplier);
    this.updatedAt = new Date();

    await prisma.productSupplier.upsert({
      where: { productId_region: { productId: this.id, region: region } },
      create: { productId: this.id, region: region, supplierId: supplier.id },
      update: { supplierId: supplier.id },
    });
  }

  // --- Pricing ---

  getResellerPrice(): number {
    return this.price.getResellerPrice();
  }

  async setMargin(marginPercentage: number): Promise<void> {
    this.price.margin = marginPercentage;
    this.updatedAt = new Date();
    await prisma.product.update({
      where: { id: this.id },
      data: { priceMargin: marginPercentage, updatedAt: this.updatedAt },
    });
  }

  // --- Stock ---

  async receiveStock(quantity: number): Promise<void> {
    if (!this.warehouse) {
      throw new Error("Cannot receive stock: no warehouse assigned");
    }
    this.stock += quantity;
    this.quantity += quantity;
    this.updatedAt = new Date();
    console.log(`Restocking ${this.name} at ${this.warehouse.name}`);
    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, quantity: this.quantity, updatedAt: this.updatedAt },
    });
  }

  async sell(quantity: number): Promise<void> {
    if (this.stock < quantity) throw new Error("Not enough stock");

    this.stock -= quantity;
    this.updatedAt = new Date();

    if (this.stock === 0) {
      this.status = "out_of_stock";
    }

    await prisma.product.update({
      where: { id: this.id },
      data: { stock: this.stock, status: this.status, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    this.notifySuppliers(`Product sold: ${this.name}`, `${quantity} unit(s) of ${this.name} were sold. Remaining stock: ${this.stock}.`);
  }

  // --- Lifecycle ---

  async deprecate(): Promise<void> {
    this.status = "deprecated";
    this.stock = 0;
    this.updatedAt = new Date();

    await prisma.product.update({
      where: { id: this.id },
      data: { status: this.status, stock: this.stock, updatedAt: this.updatedAt },
    });

    // Notify all regional suppliers
    this.notifySuppliers(`Product deprecated: ${this.name}`, `The product ${this.name} has been deprecated and removed from the catalog.`);

    // Notify customers
    this.notifications.push(this.createNotification("customers@omniproduct.com", `Product no longer available: ${this.name}`, `${this.name} is no longer available.`));
  }

  private notifySuppliers(subject: string, body: string): void {
    for (const [, supplier] of this.suppliersRegions) {
      this.notifications.push(
        this.createNotification(supplier.email, subject, body)
      );
    }
  }

  // small helper to cut down repetition in notif building
  private createNotification(recipient: string, subject: string, body: string): Notification {
    return {
      id: crypto.randomUUID(),
      recipient,
      subject,
      body,
      channel: "email",
      sentAt: new Date(),
      productId: this.id,
    };
  }
}
