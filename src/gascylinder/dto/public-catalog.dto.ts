export class PublicCatalogDto {
    products: ProductDto[];
    paymentMethods: PaymentMethodDto[];
}

export class ProductDto {
    id: string;
    type: string;
    price: number;
    description: string;
    promotions: any[];
}

export class PaymentMethodDto {
    name: string;
    key: string;
    surcharge: number; // Percentage (e.g., 10 for 10%)
}
