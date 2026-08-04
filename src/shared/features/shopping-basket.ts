import { FeatureOptions, FeatureSettingInfo } from "./feature-options-base";

export class ShoppingBasketOptions extends FeatureOptions {
	checkoutEndpoint: string = "/api/checkout";
	info_checkoutEndpoint = new FeatureSettingInfo({
		description: "The server endpoint that creates Markdown subset zip downloads.",
	});
	maxCheckoutItems: number = 5000;
	info_maxCheckoutItems = new FeatureSettingInfo({
		name: "Maximum checkout items",
		description: "Maximum number of unique Markdown documents that one checkout may contain.",
	});

	constructor() {
		super();
		this.featureId = "shopping-basket";
	}
}
